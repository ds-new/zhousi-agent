import assert from "node:assert/strict";
import { it } from "node:test";
import type { McpBinding, McpCatalogEntry } from "@diy-agent/domain";
import { McpConnectionPool } from "../src/connections.js";
import { resolveApprovedBinding } from "../src/index.js";
import { startHttpMcp } from "./fixtures/http-mcp.js";

const scope = { tenantId: "tenant-a", workspaceId: "workspace-a", sessionId: "session-a" };
const httpBinding = (url: string): McpBinding => ({ serverName: "fixture", transport: "streamable-http", url });

it("rejects unapproved credential substitutions and broadening writable MCP scope", () => {
  const binding = httpBinding("https://approved.example/mcp");
  const catalog = { ...binding, tenantId: "tenant-a", defaultSensitivity: "normal", approvalStatus: "approved", createdAt: new Date(), envRef: { authorization: "vault://approved" } } as McpCatalogEntry;
  assert.throws(() => resolveApprovedBinding({ ...binding, envRef: { authorization: "vault://other-workspace" } }, catalog), /mcp_credential_not_approved/);
  assert.throws(() => resolveApprovedBinding({ ...binding, poolScope: "tenant" }, catalog), /mcp_pool_scope_not_allowed/);
  assert.deepEqual(resolveApprovedBinding(binding, catalog).envRef, catalog.envRef);
  assert.throws(() => resolveApprovedBinding({ ...binding, envRef: { authorization: "vault://other" } }, { ...catalog, envRef: undefined }), /mcp_credential_not_approved/);
});

it("fails closed for disallowed transport destinations before resolving secrets", async () => {
  let resolutions = 0;
  const pool = new McpConnectionPool({ allowStdio: false, allowedHttpOrigins: [], resolveCredential: async () => { resolutions++; return "secret"; } });
  try {
    await assert.rejects(pool.connect({ serverName: "bad", transport: "stdio", command: process.execPath, envRef: { TOKEN: "vault://x" } }, scope), /mcp_stdio_disabled/);
    await assert.rejects(pool.connect(httpBinding("http://127.0.0.1:1/mcp"), scope), /mcp_http_origin_not_allowed/);
    await assert.rejects(pool.connect(httpBinding("file:///tmp/mcp"), scope), /mcp_url_invalid/);
    assert.equal(resolutions, 0);
  } finally { await pool.close(); }
});

it("bounds credential resolution and immediately cancels pending startup on close", async () => {
  const pool = new McpConnectionPool({ connectTimeoutMs: 50, closeTimeoutMs: 100, resolveCredential: () => new Promise(() => {}) });
  const binding = { ...httpBinding("https://approved.example/mcp"), envRef: { authorization: "vault://hung" } };
  await assert.rejects(pool.connect(binding, scope), /mcp_connect_timeout/);
  const connection = pool.connect(binding, scope);
  const rejected = assert.rejects(connection, /mcp_pool_closed/);
  const start = Date.now();
  await pool.close();
  await rejected;
  assert.ok(Date.now() - start < 500);
});

it("uses actual Streamable HTTP handshake, credentials, warm reuse, scoped sessions and DELETE cleanup", async () => {
  const fixture = await startHttpMcp({ token: "Bearer scoped-secret" });
  const resolved: string[] = [];
  const pool = new McpConnectionPool({ allowedHttpOrigins: [new URL(fixture.url).origin], resolveCredential: async (tenant, ref) => { resolved.push(`${tenant}:${ref}`); return "Bearer scoped-secret"; } });
  const binding = { ...httpBinding(fixture.url), envRef: { authorization: "vault://fixture" } };
  try {
    const [a, b] = await Promise.all([pool.connect(binding, scope), pool.connect(binding, scope)]);
    assert.equal(a.client, b.client);
    assert.equal((await a.listTools()).tools.length, 2);
    assert.deepEqual((await a.callTool({ name: "echo", arguments: { message: "real http" } })).content, [{ type: "text", text: "real http" }]);
    await a.release(); await b.release();
    const separate = await pool.connect(binding, { ...scope, tenantId: "tenant-b" });
    assert.notEqual(a.client, separate.client);
    await separate.release();
    assert.deepEqual(resolved, ["tenant-a:vault://fixture", "tenant-b:vault://fixture"]);
    await pool.close();
    assert.equal(fixture.stats().initializes, 2);
    assert.equal(fixture.stats().deleted, 2);
  } finally { await pool.close(); await fixture.close(); }
});

it("limits MCP pagination and tool calls, and releases quota after idle eviction", async () => {
  const fixture = await startHttpMcp({ repeatCursor: true });
  const pool = new McpConnectionPool({ maxConnectionsPerTenant: 1, idleTimeoutMs: 20, requestTimeoutMs: 40 });
  try {
    const a = await pool.connect(httpBinding(fixture.url), scope);
    await assert.rejects(a.listTools(), /mcp_tool_pagination_invalid/);
    await assert.rejects(a.callTool({ name: "slow", arguments: {} }), /timed out|timeout/i);
    await assert.rejects(pool.connect(httpBinding(fixture.url), { ...scope, workspaceId: "other" }), /limit_exceeded/);
    await a.release();
    await new Promise(resolve => setTimeout(resolve, 100));
    const b = await pool.connect(httpBinding(fixture.url), { ...scope, workspaceId: "other" });
    await b.release();
    assert.equal(fixture.stats().initializes, 2);
  } finally { await pool.close(); await fixture.close(); }
});

it("cancels one waiting lease without poisoning another concurrent handshake", async () => {
  const fixture = await startHttpMcp({ token: "shared" });
  let provideSecret!: (secret: string) => void;
  const pool = new McpConnectionPool({ resolveCredential: () => new Promise(resolve => { provideSecret = resolve; }) });
  const binding = { ...httpBinding(fixture.url), envRef: { authorization: "vault://shared" } };
  try {
    const controller = new AbortController();
    const first = pool.connect(binding, scope, { signal: controller.signal });
    const second = pool.connect(binding, scope);
    controller.abort(new Error("caller_cancelled"));
    await assert.rejects(first, /caller_cancelled/);
    provideSecret("shared");
    const lease = await second;
    assert.equal((await lease.listTools()).tools.length, 2);
    await lease.release();
    assert.equal(fixture.stats().initializes, 1);
  } finally { await pool.close(); await fixture.close(); }
});

it("rejects excessive tool catalogs and payloads from actual HTTP peers", async () => {
  const fixture = await startHttpMcp({ toolCount: 3 });
  const pool = new McpConnectionPool({ maxTools: 2, maxResponseBytes: 4096 });
  try {
    const lease = await pool.connect(httpBinding(fixture.url), scope);
    await assert.rejects(lease.listTools(), /mcp_tool_limit_exceeded/);
    await assert.rejects(lease.callTool({ name: "echo", arguments: { message: "x".repeat(8192) } }), /mcp_response_too_large/);
    await lease.release();
    assert.throws(() => lease.callTool({ name: "echo" }), /mcp_lease_released/);
  } finally { await pool.close(); await fixture.close(); }
});

it("cancels active requests when the pool closes", async () => {
  const fixture = await startHttpMcp();
  const pool = new McpConnectionPool({ requestTimeoutMs: 5000, closeTimeoutMs: 100 });
  try {
    const lease = await pool.connect(httpBinding(fixture.url), scope);
    const pending = assert.rejects(lease.callTool({ name: "slow", arguments: {} }), /closed|abort/i);
    await new Promise(resolve => setTimeout(resolve, 20));
    const start = Date.now();
    await pool.close();
    await pending;
    assert.ok(Date.now() - start < 1000);
    await lease.release();
  } finally { await pool.close(); await fixture.close(); }
});
