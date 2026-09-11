import assert from "node:assert/strict";
import { it } from "node:test";
import { createStore, PostgresStore } from "../src/postgres-store.js";
import pg from "pg";

it("revoked API keys disappear immediately from another replica and remain revoked on restart", async () => {
  const url = process.env.DIY_TEST_DATABASE_URL!;
  const first = await createStore(url);
  let second = await createStore(url);
  try {
    const tenant = await first.createTenant({ name: "key revocation" });
    const other = await first.createTenant({ name: "other key owner" });
    const key = await first.createApiKey(tenant.id, "revoke across replicas");
    assert.equal((await second.listApiKeys(tenant.id)).length, 1);
    assert.equal(await second.revokeApiKey(other.id, key.record.id), false);
    assert.equal(await first.revokeApiKey(tenant.id, key.record.id), true);
    assert.equal((await second.listApiKeys(tenant.id)).length, 0);
    await second.close(); second = await createStore(url);
    assert.equal((await second.listApiKeys(tenant.id)).length, 0);
  } finally { await first.close(); await second.close(); }
});

it("direct PostgresStore construction also persists inherited catalog mutations", async () => {
  const url = process.env.DIY_TEST_DATABASE_URL!;
  const store = new PostgresStore(url);
  await store.init();
  const tenant = await store.createTenant({ name: "direct constructor" });
  const workspace = (await store.createWorkspace({ tenantId: tenant.id }))!;
  await store.close();
  const restored = await createStore(url);
  try { assert.equal((await restored.getWorkspace(workspace.id))?.tenantId, tenant.id); }
  finally { await restored.close(); }
});

it("a locked tenant does not block another tenant and replicas discover new profiles", async () => {
  const url = process.env.DIY_TEST_DATABASE_URL!;
  const first = await createStore(url);
  const tenantA = await first.createTenant({ name: "parallel A" });
  const tenantB = await first.createTenant({ name: "parallel B" });
  const second = await createStore(url);
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  let pendingA: Promise<unknown> | undefined;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 15485863))", [tenantA.id]);
    let aFinished = false;
    pendingA = first.createWorkspace({ tenantId: tenantA.id }).then(value => { aFinished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(aFinished, false, "tenant A must acquire its own partition lock");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ws = await Promise.race([
      second.createWorkspace({ tenantId: tenantB.id }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("unrelated_tenant_blocked")), 2000); }),
    ]).finally(() => clearTimeout(timer));
    assert.ok(ws);
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 15485863))", [tenantA.id]);
    await pendingA;
    const created = (await second.createProfile({ tenantId: tenantB.id, workspaceId: ws.id, profile: { name: "new on replica" } }))!;
    assert.equal((await first.getProfile(created.profile.id))?.name, "new on replica");
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 15485863))", [tenantA.id]);
    await pendingA;
    client.release(); await pool.end(); await first.close(); await second.close();
  }
});

it("Postgres leases exclude another replica without blocking callback store access", async () => {
  const first = await createStore(process.env.DIY_TEST_DATABASE_URL!);
  const second = await createStore(process.env.DIY_TEST_DATABASE_URL!);
  const key = crypto.randomUUID();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = first.withLease(key, async () => {
    await first.createTenant({ name: "lease callback" });
    entered();
    await new Promise<void>(resolve => { release = resolve; });
    return true;
  });
  try {
    await ready;
    assert.equal(await second.withLease(key, async () => false), null);
    release();
    assert.equal(await held, true);
    assert.equal(await second.withLease(key, async () => "next"), "next");
  } finally { release?.(); await held; await first.close(); await second.close(); }
});

it("catalog writes avoid unrelated tenants and roll back trace SQL if checkpoint fails", async () => {
  const url = process.env.DIY_TEST_DATABASE_URL!;
  const store = await createStore(url);
  const sql = new pg.Pool({ connectionString: url });
  const tenant = await store.createTenant({ name: "atomic" });
  const unrelated = await store.createTenant({ name: "unrelated" });
  const ws = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const created = (await store.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {} }))!;
  const fn = `fail_${crypto.randomUUID().replaceAll("-", "")}`;
  await sql.query(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected checkpoint failure'; END $$`);
  const block = (schema: string) => sql.query(`CREATE TRIGGER fail_checkpoint BEFORE INSERT OR UPDATE ON "${schema}".catalog_state FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
  try {
    await block(unrelated.dbSchema);
    await store.registerSkill({ tenantId: tenant.id, workspaceId: ws.id, name: "isolated write", contentHash: "abc", source: "private" });
    await block(tenant.dbSchema);
    await assert.rejects(store.saveTrace({ profileId: created.profile.id, profileVersionId: created.version.id, output: "must roll back", latencyMs: 1 }), /injected checkpoint failure/);
    assert.equal((await store.listTraces(created.profile.id)).length, 0);
  } finally {
    await sql.query(`DROP TRIGGER IF EXISTS fail_checkpoint ON "${tenant.dbSchema}".catalog_state`);
    await sql.query(`DROP TRIGGER IF EXISTS fail_checkpoint ON "${unrelated.dbSchema}".catalog_state`);
    await sql.query(`DROP FUNCTION public.${fn}()`);
    await store.close(); await sql.end();
  }
});

it("usage event replays remain idempotent across replicas and restart", async () => {
  const url = process.env.DIY_TEST_DATABASE_URL!;
  const first = await createStore(url);
  let second = await createStore(url);
  try {
    const tenant = await first.createTenant({ name: "outbox" });
    const responses = await Promise.all([first.recordUsageOnce(tenant.id, "turn", 42), second.recordUsageOnce(tenant.id, "turn", 42)]);
    assert.equal(responses.filter(result => !result.duplicate).length, 1);
    await second.close(); second = await createStore(url);
    assert.equal((await second.recordUsageOnce(tenant.id, "turn", 42)).quota.tokensUsedToday, 42);
  } finally { await first.close(); await second.close(); }
});

it("Postgres restores multiple marketplace publication dates and lists newest first after restart", async (t) => {
  const url = process.env.DIY_TEST_DATABASE_URL;
  assert.ok(url, "set DIY_TEST_DATABASE_URL to an isolated test database");
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-01T12:00:00Z") });
  let store = await createStore(url);
  try {
    const slug = crypto.randomUUID();
    const first = await store.publishMarketplaceSkill({ slug: `${slug}-first`, name: "Earlier skill", contentHash: "first" });
    t.mock.timers.setTime(new Date("2026-09-02T12:00:00Z").getTime());
    const second = await store.publishMarketplaceSkill({ slug: `${slug}-second`, name: "Later skill", contentHash: "second" });
    await store.close();
    store = await createStore(url);

    const publications = (await store.listMarketplaceSkills()).filter((skill) => skill.id === first.id || skill.id === second.id);

    assert.deepEqual(publications.map((skill) => skill.id), [second.id, first.id]);
    assert.ok(publications.every((skill) => skill.publishedAt instanceof Date));
    assert.equal(publications[0]!.publishedAt.toISOString(), "2026-09-02T12:00:00.000Z");
    assert.equal(publications[1]!.publishedAt.toISOString(), "2026-09-01T12:00:00.000Z");
  } finally { await store.close(); }
});

it("Postgres preserves tenant, profile, session and catalogs across process-store restart", async () => {
  const url = process.env.DIY_TEST_DATABASE_URL;
  assert.ok(url, "set DIY_TEST_DATABASE_URL to an isolated test database");
  let store = await createStore(url);
  const tenant = await store.createTenant({ name: "restart", isolationMode: "schema" });
  const ws = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const { profile, version } = (await store.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {} }))!;
  await store.pinProfile(profile.id, version.id);
  const session = (await store.createSession({ tenantId: tenant.id, profileId: profile.id }))!;
  const key = await store.createApiKey(tenant.id, "persistent-admin");
  await store.registerSkill({ tenantId: tenant.id, workspaceId: ws.id, name: "persistent-skill", contentHash: "abc", source: "private" });
  await store.saveTrace({ profileId: profile.id, profileVersionId: version.id, output: "evidence", latencyMs: 1,
    taskId: "task", evalBatchId: "batch", taskSetHash: "task-snapshot-hash", executionSource: "agent_runner", evalScope: "holdout" });
  await store.close();
  store = await createStore(url);
  try {
    assert.equal((await store.getTenant(tenant.id))?.name, "restart");
    assert.equal((await store.getProfile(profile.id))?.pinnedVersionId, version.id);
    assert.equal((await store.getProfileVersion(profile.id, version.id))?.snapshot.id, profile.id);
    assert.equal((await store.listSkills(tenant.id, ws.id)).length, 1);
    assert.equal((await store.listApiKeys(tenant.id))[0]?.id, key.record.id);
    assert.equal((await store.resolveSession(session.session.id, session.sessionToken))?.tenantId, tenant.id);
    assert.equal(await store.resolveSession("another-session", session.sessionToken), null);
    const trace = (await store.listTraces(profile.id))[0]!;
    assert.equal(trace.taskSetHash, "task-snapshot-hash");
    assert.equal(trace.executionSource, "agent_runner");
    assert.equal(trace.evalScope, "holdout");
  } finally { await store.close(); }
});

it("dedicated databases recover routing and concurrent writers retain each other's profiles", async () => {
  const url = process.env.DIY_TEST_DATABASE_URL!;
  const first = await createStore(url);
  const tenant = await first.createTenant({ name: "dedicated", isolationMode: "dedicated" });
  const ws = (await first.createWorkspace({ tenantId: tenant.id }))!;
  const second = await createStore(url);
  try {
    const profiles = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: { name: `worker-${i}` } })));
    for (const created of profiles) assert.ok(await first.getProfile(created!.profile.id));
    const other = await first.createTenant({ name: "other" });
    assert.equal(await second.createProfile({ tenantId: other.id, workspaceId: ws.id, profile: {} }), null);
  } finally { await first.close(); await second.close(); }
});
