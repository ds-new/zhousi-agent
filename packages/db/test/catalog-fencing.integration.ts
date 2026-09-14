import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import pg from "pg";
import { createHash } from "node:crypto";
import { PostgresStore } from "../src/postgres-store.js";

let url: string;
let admin: pg.Pool;
const database = `fencing_${crypto.randomUUID().replaceAll("-", "")}`;
before(async () => {
  const source = process.env.DIY_TEST_DATABASE_URL; assert.ok(source);
  admin = new pg.Pool({ connectionString: source });
  await admin.query(`CREATE DATABASE "${database}"`);
  const target = new URL(source); target.pathname = `/${database}`; url = target.toString();
});
after(async () => { await admin.query(`DROP DATABASE "${database}"`); await admin.end(); });

// Lose only the platform lock connection after its final liveness check. Let B
// restore the old checkpoint before A's independent business transaction commits.
async function loseLock(t: any, a: PostgresStore, b: PostgresStore, startB: () => Promise<unknown>, checkpoint?: string) {
  let observed!: () => void;
  const restored = new Promise<void>(resolve => { observed = resolve; });
  const originalB = b.getPool().query.bind(b.getPool());
  t.mock.method(b.getPool(), "query", async (...args: any[]) => {
    const result = await (originalB as any)(...args);
    if (/^SELECT payload FROM .*catalog_state/.test(String(args[0])) && (!checkpoint || String(args[0]).includes(checkpoint))) observed();
    return result;
  });
  let pending: Promise<PromiseSettledResult<unknown>> | undefined;
  let committed = false;
  let businessPid: number | undefined;
  let armed = true;
  const original = pg.Client.prototype.query;
  t.mock.method(pg.Client.prototype, "query", function(this: any, ...args: any[]) {
    const sql = String(args[0]);
    const mine = this.connectionParameters.application_name === "fencing-a";
    if (mine && businessPid === undefined && /^(INSERT INTO|UPDATE).*catalog_state/.test(sql)) businessPid = this.processID;
    if (!armed && /^SELECT payload FROM .*catalog_state/.test(sql) && (!checkpoint || sql.includes(checkpoint)) && typeof args.at(-1) === "function") {
      const callback = args.at(-1);
      args[args.length - 1] = (...values: any[]) => { callback(...values); if (!values[0]) observed(); };
    }
    if (mine && sql === "COMMIT" && this.processID === businessPid) return (original as any).apply(this, args).then((result: unknown) => { committed = true; return result; });
    if (mine && armed && sql === "SELECT 1") {
      armed = false;
      return (async () => {
        const result = await (original as any).apply(this, args);
        await admin.query("SELECT pg_terminate_backend($1)", [this.processID]);
        pending = Promise.allSettled([startB()]).then(([outcome]) => outcome);
        await bounded(restored);
        return result;
      })();
    }
    return (original as any).apply(this, args);
  });
  return { outcome: async () => { assert.ok(pending); return pending; }, committed: () => committed };
}
async function workspaceNames(tenant: { dbSchema: string; dedicatedDatabaseUrl?: string }) {
  const pool = new pg.Pool({ connectionString: tenant.dedicatedDatabaseUrl ?? url });
  try {
    const schema = tenant.dedicatedDatabaseUrl ? "public" : tenant.dbSchema;
    const result = await pool.query(`SELECT payload FROM "${schema}".catalog_state WHERE id='catalogs'`);
    return result.rows[0].payload.maps.workspaces.map((entry: [string, { name: string }]) => entry[1].name);
  } finally { await pool.end(); }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fault_probe_barrier_timeout")), 5000); })]); }
  finally { clearTimeout(timer); }
}
function ownerUrl() { const target = new URL(url); target.searchParams.set("application_name", "fencing-a"); return target.toString(); }

for (const isolationMode of ["schema", "dedicated"] as const) {
  it(`${isolationMode}: lock loss cannot overwrite a committed checkpoint or retain a conflicting audit`, async (t) => {
    const a = new PostgresStore(ownerUrl()); const b = new PostgresStore(url);
    let dedicatedName: string | undefined;
    try {
      const tenant = await a.createTenant({ name: "fencing tenant", isolationMode });
      if (isolationMode === "dedicated") dedicatedName = tenant.dbSchema;
      const ws = (await a.createWorkspace({ tenantId: tenant.id }))!;
      const profile = (await a.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {} }))!;
      await a.pinProfile(profile.profile.id, profile.version.id);
      await b.init();
      const probe = await loseLock(t, a, b, () => b.createSession({ tenantId: tenant.id, profileId: profile.profile.id }), `"${isolationMode === "dedicated" ? "public" : tenant.dbSchema}".catalog_state`);
      await a.createWorkspace({ tenantId: tenant.id, name: "committed-A" }).catch(() => {});
      const result = await probe.outcome();
      assert.equal(probe.committed(), true, "fault must occur after liveness check and permit A COMMIT");
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.match(String(result.reason), /catalog_write_conflict/);
      assert.ok((await workspaceNames(tenant)).includes("committed-A"));
      assert.equal((await b.listAuditLog(tenant.id)).filter(event => event.action === "session.created").length, 0);
    } finally {
      t.mock.restoreAll(); await a.close(); await b.close();
      if (dedicatedName) {
        // Provisioned database belongs only to this disposable regression fixture.
        await admin.query(`DROP DATABASE "${dedicatedName}"`);
        const cleanup = new pg.Pool({ connectionString: url });
        await cleanup.query("DELETE FROM platform.tenants WHERE db_schema=$1", [dedicatedName]); await cleanup.end();
      }
    }
  });
}

it("marketplace first-write CAS fences global operations after lock loss", async (t) => {
  const a = new PostgresStore(ownerUrl()); const b = new PostgresStore(url);
  try {
    await a.init(); await b.init();
    const input = { slug: "a", name: "published-A", contentHash: "hash-a" };
    const probe = await loseLock(t, a, b, () => b.publishMarketplaceSkill({ ...input, slug: "b", name: "stale-B" }), "platform.catalog_state");
    await a.publishMarketplaceSkill(input).catch(() => {});
    const result = await probe.outcome();
    assert.equal(probe.committed(), true);
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.match(String(result.reason), /catalog_write_conflict/);
    assert.deepEqual((await b.listMarketplaceSkills()).map(skill => skill.name), ["published-A"]);
  } finally { t.mock.restoreAll(); await a.close(); await b.close(); }
});

it("cold profile ownership lookup cannot commit a stale global snapshot", async (t) => {
  const a = new PostgresStore(ownerUrl()); const b = new PostgresStore(url);
  try {
    const tenant = await a.createTenant({ name: "cold owner" });
    await b.init(); // Replica has no owner index for the profile created later.
    const ws = (await a.createWorkspace({ tenantId: tenant.id }))!;
    const created = (await a.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {} }))!;
    const probe = await loseLock(t, a, b, () => b.pinProfile(created.profile.id, created.version.id), `"${tenant.dbSchema}".catalog_state`);
    await a.createWorkspace({ tenantId: tenant.id, name: "cold-A" }).catch(() => {});
    const result = await probe.outcome();
    assert.equal(probe.committed(), true);
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.match(String(result.reason), /catalog_write_conflict/);
    assert.equal((await b.getProfile(created.profile.id))?.pinnedVersionId, undefined);
    assert.ok((await workspaceNames(tenant)).includes("cold-A"));
  } finally { t.mock.restoreAll(); await a.close(); await b.close(); }
});

for (const isolationMode of ["schema", "dedicated"] as const) {
  it(`${isolationMode}: pin evidence transaction blocks a newer trace after platform lock loss`, async (t) => {
    const a = new PostgresStore(ownerUrl()); const b = new PostgresStore(url);
    let dedicatedName: string | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      const tenant = await a.createTenant({ name: "pin evidence fencing", isolationMode });
      if (isolationMode === "dedicated") dedicatedName = tenant.dbSchema;
      const ws = (await a.createWorkspace({ tenantId: tenant.id }))!;
      const created = (await a.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {} }))!;
      const snapshot = (await a.getProfileVersion(created.profile.id, created.version.id))!.snapshot;
      const taskSetHash = createHash("sha256").update(JSON.stringify({ tasks: [], snapshot })).digest("hex");
      const trace = { profileId: created.profile.id, profileVersionId: created.version.id, latencyMs: 1.2, output: "evidence", evalScope: "profile" as const, taskSetHash };
      await a.saveTrace({ ...trace, evalBatchId: "a" }); await b.init();
      const original = pg.Client.prototype.query;
      let armed = true;
      let contenderPid: number | undefined;
      let entered!: () => void;
      const contending = new Promise<void>(resolve => { entered = resolve; });
      t.mock.method(pg.Client.prototype, "query", function(this: any, ...args: any[]) {
        const sql = String(args[0]);
        if (!armed && /pg_advisory_xact_lock/.test(sql)) {
          contenderPid = this.processID;
          const result = (original as any).apply(this, args); entered(); return result;
        }
        if (armed && this.connectionParameters.application_name === "fencing-a" && sql === "SELECT 1") {
          armed = false;
          return (async () => {
            const result = await (original as any).apply(this, args);
            await admin.query("SELECT pg_terminate_backend($1)", [this.processID]);
            pending = b.saveTrace({ ...trace, evalBatchId: "z" });
            await bounded(contending);
            let blocked = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const status = await admin.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [contenderPid]);
              if (status.rows[0]?.blocked) { blocked = true; break; }
            }
            assert.equal(blocked, true, "new evidence must wait for pin's physical database transaction");
            return result;
          })();
        }
        return (original as any).apply(this, args);
      });
      await a.pinProfile(created.profile.id, created.version.id, { taskSetHash, evalBatchId: "a" }).catch(() => {});
      assert.ok(pending); await pending;
      assert.equal((await b.getProfile(created.profile.id))?.pinnedVersionId, created.version.id);
      assert.equal((await b.listTraces(created.profile.id)).length, 2);
    } finally {
      t.mock.restoreAll(); await pending?.catch(() => {}); await a.close(); await b.close();
      if (dedicatedName) {
        await admin.query(`DROP DATABASE "${dedicatedName}"`);
        const cleanup = new pg.Pool({ connectionString: url });
        await cleanup.query("DELETE FROM platform.tenants WHERE db_schema=$1", [dedicatedName]); await cleanup.end();
      }
    }
  });
}
