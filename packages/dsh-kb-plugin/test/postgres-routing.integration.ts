import assert from "node:assert/strict";
import { it } from "node:test";
import pg from "pg";
import type { TenantId, WorkspaceId } from "@diy-agent/domain";
import { createKbRuntime } from "../src/kb-runtime.js";

it("routes KB tenants to separate PostgreSQL schemas and recovers after runtime restart", async () => {
  const databaseUrl = process.env.DIY_TEST_DATABASE_URL!;
  assert.ok(databaseUrl, "DIY_TEST_DATABASE_URL is required");
  const sql = new pg.Pool({ connectionString: databaseUrl });
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schemas = { a: `kb_a_${suffix}`, b: `kb_b_${suffix}` };
  const resolver = async (tenantId: TenantId) => tenantId === "a" || tenantId === "b" ? { databaseUrl, schema: schemas[tenantId] } : null;
  const config = { requireTenant: true, resolveTenantDatabase: resolver, embeddingProvider: async () => Array.from({ length: 128 }, (_, i) => i === 0 ? 1 : 0) };
  let runtime = createKbRuntime(config);
  try {
    await sql.query("CREATE EXTENSION IF NOT EXISTS vector");
    for (const schema of Object.values(schemas)) {
      await sql.query(`CREATE SCHEMA ${schema}`);
      await sql.query(`CREATE TABLE ${schema}.kb_documents (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, title text NOT NULL, content text NOT NULL, embedding vector(128), created_at timestamptz NOT NULL)`);
    }
    const kbConfig = { internal: { enabled: true } };
    const workspaceId = "same-local-workspace-id" as WorkspaceId;
    const a = await runtime.ingest({ tenantId: "a" as TenantId, workspaceId, kbConfig, title: "Policy A", content: "Refund policy tenant A 30 days" });
    const b = await runtime.ingest({ tenantId: "b" as TenantId, workspaceId, kbConfig, title: "Policy B", content: "Refund policy tenant B 60 days" });
    assert.ok(a); assert.ok(b);
    await runtime.close();
    runtime = createKbRuntime(config);
    const resultA = await runtime.search({ tenantId: "a" as TenantId, workspaceId, kbConfig, query: "Refund policy" });
    const resultB = await runtime.search({ tenantId: "b" as TenantId, workspaceId, kbConfig, query: "Refund policy" });
    assert.deepEqual(resultA.hits.map(hit => hit.documentId), [a.id]);
    assert.deepEqual(resultB.hits.map(hit => hit.documentId), [b.id]);
    for (const schema of Object.values(schemas)) assert.equal((await sql.query(`SELECT count(*) FROM ${schema}.kb_documents`)).rows[0].count, "1");
    await assert.rejects(runtime.search({ tenantId: "unknown" as TenantId, workspaceId, kbConfig, query: "Refund policy" }), /kb_tenant_database_not_configured/);
  } finally {
    await runtime.close();
    for (const schema of Object.values(schemas)) await sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end();
  }
});
