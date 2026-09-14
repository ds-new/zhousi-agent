import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import pg from "pg";
import { createHash } from "node:crypto";
import { PostgresStore } from "../src/postgres-store.js";

let architectureUrl: string;
let administrativePool: pg.Pool;
const testDatabase = `architecture_${crypto.randomUUID().replaceAll("-", "")}`;
before(async () => {
  const url = process.env.DIY_TEST_DATABASE_URL; assert.ok(url, "isolated PostgreSQL URL required");
  administrativePool = new pg.Pool({ connectionString: url });
  await administrativePool.query(`CREATE DATABASE "${testDatabase}"`);
  const target = new URL(url); target.pathname = `/${testDatabase}`; architectureUrl = target.toString();
});
after(async () => {
  if (administrativePool) { await administrativePool.query(`DROP DATABASE IF EXISTS "${testDatabase}"`); await administrativePool.end(); }
});
function databaseUrl() { assert.ok(architectureUrl); return architectureUrl; }

it("one store progresses tenant B while tenant A waits, without mixing operation state", async () => {
  const store = new PostgresStore(databaseUrl());
  const a = await store.createTenant({ name: "A concurrent context" });
  const b = await store.createTenant({ name: "B concurrent context" });
  const sql = new pg.Pool({ connectionString: databaseUrl() }); const lock = await sql.connect();
  let pending: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 15485863))", [a.id]);
    pending = store.createWorkspace({ tenantId: a.id, name: "A-only" });
    const workspaceB = await Promise.race([store.createWorkspace({ tenantId: b.id, name: "B-only" }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("same_instance_cross_tenant_blocked")), 1000); })]);
    assert.equal(workspaceB?.tenantId, b.id);
    await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 15485863))", [a.id]);
    const workspaceA = await pending as { id: string; tenantId: string; name: string };
    assert.equal(workspaceA.tenantId, a.id);
    assert.equal((await store.getWorkspace(workspaceB!.id))?.name, "B-only");
  } finally {
    clearTimeout(timer);
    await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 15485863))", [a.id]);
    await pending; lock.release(); await sql.end(); await store.close();
  }
});

it("known-tenant reads and aggregated session bootstrap avoid global metadata and marketplace reads", async (t) => {
  const store = new PostgresStore(databaseUrl());
  const tenant = await store.createTenant({ name: "read projection", gateway: { rateLimitRpm: 2 } });
  const workspace = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const created = (await store.createProfile({ tenantId: tenant.id, workspaceId: workspace.id, profile: {} }))!;
  await store.pinProfile(created.profile.id, created.version.id);
  const session = (await store.createSession({ tenantId: tenant.id, profileId: created.profile.id }))!;
  const pool = store.getPool(); const query = pool.query.bind(pool); const statements: string[] = [];
  t.mock.method(pool, "query", (...args: any[]) => { statements.push(String(args[0])); return (query as any)(...args); });
  try {
    assert.ok(await store.resolveSessionBootstrap(session.session.id, session.sessionToken));
    assert.equal(statements.filter(sql => /SELECT .*platform\.tenants/i.test(sql) && !/WHERE id\s*=\s*\$1/i.test(sql)).length, 0);
    assert.equal(statements.filter(sql => /platform\.catalog_state/.test(sql)).length, 0);
    assert.equal(statements.filter(sql => /SELECT payload FROM .*\.catalog_state/.test(sql)).length, 1);
    assert.equal(statements.filter(sql => /INSERT INTO .*\.catalog_state/.test(sql)).length, 0);
    assert.equal((await store.resolveSessionBootstrap(session.session.id, session.sessionToken, true))?.quota?.allowed, true);
    const replica = new PostgresStore(databaseUrl());
    try { assert.equal((await replica.resolveSessionBootstrap(session.session.id, session.sessionToken, true))?.quota?.allowed, false); }
    finally { await replica.close(); }
  } finally { await store.close(); }
});

it("trace SQL writes do not enlarge catalog checkpoints and reads do not restore the catalog", async (t) => {
  const store = new PostgresStore(databaseUrl());
  const tenant = await store.createTenant({ name: "trace projection" });
  const ws = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const { profile, version } = (await store.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {} }))!;
  const pool = store.getPool();
  const before = await pool.query(`SELECT payload FROM "${tenant.dbSchema}".catalog_state WHERE id='catalogs'`);
  try {
    for (let i = 0; i < 10; i++) await store.saveTrace({ profileId: profile.id, profileVersionId: version.id, output: "x".repeat(10000), latencyMs: 1 });
    const after = await pool.query(`SELECT payload FROM "${tenant.dbSchema}".catalog_state WHERE id='catalogs'`);
    assert.equal(createHash("sha256").update(JSON.stringify(after.rows[0].payload)).digest("hex"), createHash("sha256").update(JSON.stringify(before.rows[0].payload)).digest("hex"));
    const query = pool.query.bind(pool); const statements: string[] = [];
    t.mock.method(pool, "query", (...args: any[]) => { statements.push(String(args[0])); return (query as any)(...args); });
    assert.equal((await store.listTraces(profile.id)).length, 10);
    assert.equal(statements.filter(sql => /catalog_state/.test(sql)).length, 0);
    t.diagnostic(JSON.stringify({ traceOutputBytes: 100000, catalogBytes: Buffer.byteLength(JSON.stringify(after.rows[0].payload)), readQueries: statements.length }));
  } finally { await store.close(); }
});

it("trace latency preserves fractional milliseconds across PostgreSQL write and restart", async () => {
  let store = new PostgresStore(databaseUrl());
  const tenant = await store.createTenant({ name: "fractional latency" });
  const workspace = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const { profile, version } = (await store.createProfile({ tenantId: tenant.id, workspaceId: workspace.id, profile: {} }))!;
  try {
    await store.getPool().query(`ALTER TABLE "${tenant.dbSchema}".eval_traces ALTER COLUMN latency_ms TYPE INTEGER USING latency_ms::integer`);
    const legacy = await store.saveTrace({ profileId: profile.id, profileVersionId: version.id, output: "legacy integer timer", latencyMs: 7 });
    await store.close(); store = new PostgresStore(databaseUrl());
    await store.init();
    const saved = await store.saveTrace({ profileId: profile.id, profileVersionId: version.id, output: "real timer precision", latencyMs: 1.2345 });
    await store.close(); store = new PostgresStore(databaseUrl());
    const trace = (await store.listTraces(profile.id)).find(entry => entry.id === saved.id);
    assert.equal(trace?.latencyMs, 1.2345);
    assert.equal((await store.listTraces(profile.id)).find(entry => entry.id === legacy.id)?.latencyMs, 7);
  } finally { await store.close(); }
});

it("legacy checkpoint traces migrate once, preserve duplicate SQL rows and remain usable by the pin gate", async () => {
  let store = new PostgresStore(databaseUrl());
  const tenant = await store.createTenant({ name: "trace migration" });
  const ws = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const { profile, version } = (await store.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {} }))!;
  const task = await store.createGoldenTask({ profileId: profile.id, input: "proof", expectedContains: "verified" });
  const tasks = await store.listGoldenTasks(profile.id);
  const persisted = (await store.getProfileVersion(profile.id, version.id))!;
  const taskSetHash = createHash("sha256").update(JSON.stringify({ tasks: tasks.sort((a, b) => a.id.localeCompare(b.id)), snapshot: persisted.snapshot })).digest("hex");
  const evidence = { taskSetHash, evalBatchId: "2026-legacy-proof" };
  assert.equal(await store.pinProfile(profile.id, version.id, evidence), null);
  const existing = await store.saveTrace({ profileId: profile.id, profileVersionId: version.id, output: "verified", latencyMs: 1, taskId: task.id,
    evalBatchId: evidence.evalBatchId, taskSetHash, executionSource: "agent_runner", evalScope: "profile" });
  const legacy = { ...existing, id: crypto.randomUUID(), output: "legacy retained" };
  await store.getPool().query(`UPDATE "${tenant.dbSchema}".catalog_state SET payload=jsonb_set(payload,'{maps,traces}',$1::jsonb) WHERE id='catalogs'`, [JSON.stringify([[existing.id, existing], [legacy.id, legacy]])]);
  await store.close(); store = new PostgresStore(databaseUrl());
  try {
    await store.init();
    const traces = await store.listTraces(profile.id);
    assert.equal(traces.length, 2);
    assert.ok(traces.some(trace => trace.id === legacy.id && trace.output === "legacy retained"));
    assert.equal((await store.pinProfile(profile.id, version.id, evidence))?.pinnedVersionId, version.id);
    assert.equal(await store.pinProfile(profile.id, version.id, { ...evidence, taskSetHash: "changed" }), null);
    const payload = await store.getPool().query(`SELECT payload FROM "${tenant.dbSchema}".catalog_state WHERE id='catalogs'`);
    assert.equal(Object.hasOwn(payload.rows[0].payload.maps, "traces"), false);
    await store.close(); store = new PostgresStore(databaseUrl());
    assert.equal((await store.listTraces(profile.id)).length, 2);
  } finally { await store.close(); }
});

it("contradictory legacy trace IDs fail migration without changing either source", async () => {
  const store = new PostgresStore(databaseUrl());
  const tenant = await store.createTenant({ name: "trace conflict" });
  const ws = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const { profile, version } = (await store.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {} }))!;
  const existing = await store.saveTrace({ profileId: profile.id, profileVersionId: version.id, output: "SQL original", latencyMs: 1 });
  const pool = store.getPool();
  await pool.query(`UPDATE "${tenant.dbSchema}".catalog_state SET payload=jsonb_set(payload,'{maps,traces}',$1::jsonb) WHERE id='catalogs'`, [JSON.stringify([[existing.id, { ...existing, output: "checkpoint contradiction" }]])]);
  const broken = new PostgresStore(databaseUrl());
  try {
    await assert.rejects(broken.init(), /legacy_trace_conflict/);
    assert.equal((await pool.query(`SELECT output FROM "${tenant.dbSchema}".eval_traces WHERE id=$1`, [existing.id])).rows[0].output, "SQL original");
    assert.equal((await pool.query(`SELECT payload FROM "${tenant.dbSchema}".catalog_state WHERE id='catalogs'`)).rows[0].payload.maps.traces[0][1].output, "checkpoint contradiction");
  } finally {
    await pool.query(`UPDATE "${tenant.dbSchema}".catalog_state SET payload=payload #- '{maps,traces}' WHERE id='catalogs'`);
    await broken.close(); await store.close();
  }
});

it("mixed tenant load preserves all profiles and independently meters duplicate usage", async (t) => {
  const store = new PostgresStore(databaseUrl());
  const tenants = await Promise.all(Array.from({ length: 8 }, (_, i) => store.createTenant({ name: `load-${i}` })));
  const workspaces = await Promise.all(tenants.map(tenant => store.createWorkspace({ tenantId: tenant.id })));
  const start = performance.now();
  try {
    const profiles = await Promise.all(Array.from({ length: 64 }, (_, i) => {
      const n = i % tenants.length;
      return store.createProfile({ tenantId: tenants[n]!.id, workspaceId: workspaces[n]!.id, profile: { name: `worker-${i}` } });
    }));
    assert.equal(profiles.filter(Boolean).length, 64);
    for (let n = 0; n < tenants.length; n++) {
      const results = await Promise.all(Array.from({ length: 6 }, () => store.recordUsageOnce(tenants[n]!.id, "repeat", n + 1)));
      assert.equal(results.filter(result => !result.duplicate).length, 1);
      assert.ok(results.every(result => result.quota.tokensUsedToday === n + 1));
    }
    const restored = new PostgresStore(databaseUrl());
    try {
      for (let i = 0; i < profiles.length; i++) {
        const profile = (await restored.getProfile(profiles[i]!.profile.id))!;
        assert.equal(profile.workspaceId, workspaces[i % tenants.length]!.id);
      }
    } finally { await restored.close(); }
    t.diagnostic(JSON.stringify({ tenants: 8, createdProfiles: 64, replayedUsageEvents: 48, elapsedMs: Math.round(performance.now() - start) }));
  } finally { await store.close(); }
});
