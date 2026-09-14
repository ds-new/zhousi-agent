import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { TenantId, WorkspaceId } from "@diy-agent/domain";
import { InternalKbStore, resetInternalIndexForTests } from "@diy-agent/kb-rag";
import { createKbRuntime } from "../src/kb-runtime.js";

describe("knowledge base tenant isolation", () => {
  beforeEach(() => resetInternalIndexForTests());
  afterEach(() => resetInternalIndexForTests());

  it("keeps documents private when two tenants use the same workspace ID", async () => {
    const runtime = createKbRuntime({ internalStore: new InternalKbStore() });
    const workspaceId = "shared-workspace-id" as WorkspaceId;
    const tenantA = "tenant-a" as TenantId;
    const tenantB = "tenant-b" as TenantId;
    const kbConfig = { internal: { enabled: true } };
    const documentA = await runtime.ingest({ tenantId: tenantA, workspaceId, kbConfig, title: "Tenant A confidential policy", content: "Refund policy for tenant A allows refunds for 30 days." });
    const documentB = await runtime.ingest({ tenantId: tenantB, workspaceId, kbConfig, title: "Tenant B confidential policy", content: "Refund policy for tenant B allows refunds for 60 days." });
    assert.ok(documentA);
    assert.ok(documentB);

    const resultA = await runtime.search({ tenantId: tenantA, workspaceId, kbConfig, query: "Refund policy" });
    const resultB = await runtime.search({ tenantId: tenantB, workspaceId, kbConfig, query: "Refund policy" });

    assert.deepEqual(resultA.hits.map((hit) => hit.documentId), [documentA.id]);
    assert.deepEqual(resultB.hits.map((hit) => hit.documentId), [documentB.id]);
  });
});

it("requires tenant identity and durable storage when configured for production", async () => {
  const runtime = createKbRuntime({ requireTenant: true });
  const input = { workspaceId: "workspace" as WorkspaceId, kbConfig: { internal: { enabled: true } }, query: "policy" };
  await assert.rejects(runtime.search(input), /kb_tenant_required/);
  await assert.rejects(runtime.search({ ...input, tenantId: "tenant" as TenantId }), /kb_persistent_store_required/);
  await runtime.close();
  await assert.rejects(runtime.search({ ...input, tenantId: "tenant" as TenantId }), /kb_runtime_closed/);
});

it("validates tenant database resolution before issuing SQL or falling back to local data", async () => {
  const resolved: string[] = [];
  const runtime = createKbRuntime({ requireTenant: true, resolveTenantDatabase: async tenantId => { resolved.push(tenantId); return null; } });
  try {
    await assert.rejects(runtime.ingest({ tenantId: "missing-tenant" as TenantId, workspaceId: "workspace" as WorkspaceId, kbConfig: { internal: { enabled: true } }, title: "private", content: "data" }), /kb_tenant_database_not_configured/);
    assert.deepEqual(resolved, ["missing-tenant"]);
  } finally { await runtime.close(); }
});

it("does not silently use development hash embeddings in production", async () => {
  const runtime = createKbRuntime({ requireTenant: true, internalStore: new InternalKbStore() });
  try {
    await assert.rejects(runtime.search({ tenantId: "tenant" as TenantId, workspaceId: "workspace" as WorkspaceId, kbConfig: { internal: { enabled: true } }, query: "semantic search" }), /kb_embedding_provider_required/);
  } finally { await runtime.close(); }
});

it("passes search budget and cancellation to embeddings without crossing tenant namespaces", async () => {
  type Pending = { signal?: AbortSignal; timeoutMs?: number; finish: () => void };
  const waiting = new Map<string, Pending>();
  let bothEntered!: () => void;
  const both = new Promise<void>(resolve => { bothEntered = resolve; });
  const vector = Array.from({ length: 128 }, (_, index) => index === 0 ? 1 : 0);
  const runtime = createKbRuntime({ embeddingProvider: async (text, tenantId, options) => {
    if (text === "shared query") await new Promise<void>((resolve, reject) => {
      const abort = () => reject(options?.signal?.reason);
      waiting.set(tenantId!, { signal: options?.signal, timeoutMs: options?.timeoutMs, finish: () => { options?.signal?.removeEventListener("abort", abort); resolve(); } });
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (waiting.size === 2) bothEntered();
    });
    return vector;
  } });
  const workspaceId = crypto.randomUUID() as WorkspaceId;
  const kbConfig = { internal: { enabled: true } };
  const first = "a" as TenantId, second = "b" as TenantId;
  const controller = new AbortController();
  const a = await runtime.ingest({ tenantId: first, workspaceId, kbConfig, title: "a", content: "private a" });
  const b = await runtime.ingest({ tenantId: second, workspaceId, kbConfig, title: "b", content: "private b" });
  const searchA = runtime.search({ tenantId: first, workspaceId, kbConfig, query: "shared query", signal: controller.signal, timeoutMs: 5000 });
  const searchB = runtime.search({ tenantId: second, workspaceId, kbConfig, query: "shared query", timeoutMs: 6000 });
  const failureA = assert.rejects(searchA, /tenant_a_cancelled/);
  try {
    await both;
    assert.equal(waiting.get(first)?.timeoutMs, 5000);
    assert.equal(waiting.get(second)?.timeoutMs, 6000);
    controller.abort(new Error("tenant_a_cancelled"));
    await failureA;
    assert.equal(waiting.get(second)?.signal?.aborted, false);
    waiting.get(second)!.finish();
    assert.deepEqual((await searchB).hits.map(hit => hit.documentId), [b!.id]);
    assert.notEqual(a!.id, b!.id);
  } finally {
    for (const pending of waiting.values()) pending.finish();
    await Promise.allSettled([searchA, searchB]);
    await runtime.close();
  }
});
