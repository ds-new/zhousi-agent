import assert from "node:assert/strict";
import { createServer } from "node:http";
import { it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { WorkspaceId, McpBinding } from "@diy-agent/domain";
import { HybridKbService } from "../src/index.js";
import { InternalKbStore } from "../src/internal-kb-store.js";
import { ProtocolMcpKbSearchClient } from "../src/protocol-mcp-kb-client.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function abortableGate(promise: Promise<void>, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new Error("cancelled"));
    promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}
// The watchdog only terminates a broken test. Concurrency is proved by both adapters entering
// while neither release gate has opened, not by comparing elapsed execution times.
async function watchdog(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("adapter_barrier_not_reached")), 2000); })]); }
  finally { clearTimeout(timer); }
}
const vector = Array.from({ length: 128 }, (_, index) => index === 0 ? 1 : 0);

async function fixture() {
  const internalEntered = gate(), externalEntered = gate(), internalRelease = gate(), externalRelease = gate();
  const internalCancelled = gate(), externalCancelled = gate();
  let internalError: Error | undefined;
  let externalError: Error | undefined;
  let calls = 0;
  const workspaceId = crypto.randomUUID() as WorkspaceId;
  const store = new InternalKbStore(async (_text, options) => {
    internalEntered.resolve();
    try { await abortableGate(internalRelease.promise, options?.signal); }
    catch (error) { internalCancelled.resolve(); throw error; }
    if (internalError) throw internalError;
    return vector;
  });
  const document = await store.ingest({ workspaceId, title: "Internal", content: "refund policy", embedding: vector });
  const servers = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();
  const http = createServer(async (req, res) => {
    try {
      let body: any;
      if (req.method === "POST") { let raw = ""; for await (const chunk of req) raw += chunk; body = JSON.parse(raw); }
      let connection = servers.get(String(req.headers["mcp-session-id"]));
      if (!connection && body?.method === "initialize") {
        const server = new McpServer({ name: "kb-concurrency-fixture", version: "1.0.0" });
        server.registerTool("search", { inputSchema: { query: z.string() } }, async ({ query }, extra) => {
          calls++; externalEntered.resolve();
          try { await abortableGate(externalRelease.promise, extra.signal); }
          catch (error) { externalCancelled.resolve(); throw error; }
          if (externalError) throw externalError;
          return { content: [{ type: "text", text: JSON.stringify({ hits: [{ documentId: "external", title: "External", snippet: query, score: 1 }] }) }] };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
        connection = { server, transport };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        servers.set(transport.sessionId!, connection);
      } else if (connection) await connection.transport.handleRequest(req, res, body);
      else res.writeHead(404).end();
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const binding: McpBinding = { serverName: "external", transport: "streamable-http", url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`, sensitivity: "readonly" };
  const client = new ProtocolMcpKbSearchClient();
  const hybrid = (sensitivity: McpBinding["sensitivity"] = "readonly") => new HybridKbService({ internal: { enabled: true }, externalMcp: { ...binding, sensitivity }, fusionWeights: { internal: 0.8, external: 0.2 } }, store, client, { tenantId: "fixture-tenant", workspaceId, sessionId: "fixture-session" });
  return { workspaceId, document, hybrid, internalEntered, externalEntered, internalRelease, externalRelease, internalCancelled, externalCancelled,
    calls: () => calls, failExternal: (error: Error) => { externalError = error; }, failInternal: (error: Error) => { internalError = error; },
    async close() {
      internalRelease.resolve(); externalRelease.resolve();
      await client.close();
      await Promise.all([...servers.values()].map(c => c.server.close()));
      http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    } };
}

it("starts real internal embedding and readonly MCP retrieval before either release gate opens, retaining source weights", async () => {
  const f = await fixture();
  const search = f.hybrid().search(f.workspaceId, "refund");
  try {
    await watchdog(Promise.all([f.internalEntered.promise, f.externalEntered.promise]));
    f.externalRelease.resolve(); f.internalRelease.resolve();
    const result = await search;
    assert.deepEqual(result.hits.map(hit => hit.documentId), [f.document.id, "external"]);
    assert.ok(Math.abs(result.hits[0]!.score - 0.8 / 61) < 1e-15);
    assert.ok(Math.abs(result.hits[1]!.score - 0.2 / 61) < 1e-15);
  } finally { f.internalRelease.resolve(); f.externalRelease.resolve(); await search.catch(() => {}); await f.close(); }
});

it("preserves serial execution for normal and high-sensitivity external bindings", async () => {
  for (const sensitivity of ["normal", "high"] as const) {
    const f = await fixture();
    const search = f.hybrid(sensitivity).search(f.workspaceId, "refund");
    try {
      await watchdog(f.internalEntered.promise);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.calls(), 0);
      f.internalRelease.resolve();
      await watchdog(f.externalEntered.promise);
      f.externalRelease.resolve();
      assert.equal((await search).hits.length, 2);
    } finally { f.internalRelease.resolve(); f.externalRelease.resolve(); await search.catch(() => {}); await f.close(); }
  }
});

it("cancels the real MCP sibling when internal retrieval fails", async () => {
  const f = await fixture();
  f.failInternal(new Error("embedding_failed"));
  const search = f.hybrid().search(f.workspaceId, "refund");
  const failure = assert.rejects(search, /embedding_failed/);
  try {
    await watchdog(Promise.all([f.internalEntered.promise, f.externalEntered.promise]));
    f.internalRelease.resolve();
    await failure;
    await watchdog(f.externalCancelled.promise);
  } finally { f.internalRelease.resolve(); f.externalRelease.resolve(); await failure; await f.close(); }
});

it("forwards caller cancellation to both real retrieval adapters", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const search = f.hybrid().search(f.workspaceId, "refund", { signal: controller.signal });
  const failure = assert.rejects(search, /caller_cancelled/);
  try {
    await watchdog(Promise.all([f.internalEntered.promise, f.externalEntered.promise]));
    controller.abort(new Error("caller_cancelled"));
    await failure;
    await watchdog(Promise.all([f.internalCancelled.promise, f.externalCancelled.promise]));
  } finally { f.internalRelease.resolve(); f.externalRelease.resolve(); await failure.catch(() => {}); await f.close(); }
});

it("cancels internal embedding when the real MCP peer fails", async () => {
  const f = await fixture();
  f.failExternal(new Error("upstream_search_failed"));
  const search = f.hybrid().search(f.workspaceId, "refund");
  const failure = assert.rejects(search, /mcp_kb_search_failed/);
  try {
    await watchdog(Promise.all([f.internalEntered.promise, f.externalEntered.promise]));
    f.externalRelease.resolve();
    await failure;
    await watchdog(f.internalCancelled.promise);
  } finally { f.internalRelease.resolve(); f.externalRelease.resolve(); await failure; await f.close(); }
});

it("uses one total budget to cancel both retrieval adapters", async () => {
  const f = await fixture();
  const search = f.hybrid().search(f.workspaceId, "refund", { timeoutMs: 1000 });
  const failure = assert.rejects(search, /kb_search_timeout/);
  try {
    await watchdog(Promise.all([f.internalEntered.promise, f.externalEntered.promise]));
    await failure;
    await watchdog(Promise.all([f.internalCancelled.promise, f.externalCancelled.promise]));
  } finally { f.internalRelease.resolve(); f.externalRelease.resolve(); await failure; await f.close(); }
});

it("does not launch any adapter after cancellation or an invalid budget", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort(new Error("already_cancelled"));
  try {
    await assert.rejects(f.hybrid().search(f.workspaceId, "refund", { signal: controller.signal }), /already_cancelled/);
    await assert.rejects(f.hybrid().search(f.workspaceId, "refund", { timeoutMs: 0 }), /kb_search_budget_invalid/);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

it("observes a sibling's late rejection after a synchronous adapter failure", async () => {
  let rejectInternal!: (error: Error) => void;
  let internalSignal: AbortSignal | undefined;
  const pending = new Promise<never>((_, reject) => { rejectInternal = reject; });
  const store = {
    ingest: async () => { throw new Error("not_used"); },
    search: (_workspace: WorkspaceId, _query: string, _limit?: number, options?: { signal?: AbortSignal }) => { internalSignal = options?.signal; return pending; },
  };
  const service = new HybridKbService({ internal: { enabled: true }, externalMcp: { serverName: "sync-failure", transport: "streamable-http", url: "https://fixture.invalid", sensitivity: "readonly" } }, store,
    { search: () => { throw new Error("synchronous_external_failure"); } });
  await assert.rejects(service.search("workspace" as WorkspaceId, "query"), /synchronous_external_failure/);
  assert.equal(internalSignal?.aborted, true);
  rejectInternal(new Error("late_internal_failure"));
  // node:test itself fails on any unhandled rejection, including after a test has completed.
  await new Promise(resolve => setImmediate(resolve));
});
