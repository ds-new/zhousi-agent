import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AuditEvent, ProfileId, Tenant, TenantGateway, TenantId } from "@diy-agent/domain";
import { MemoryStore } from "./memory-store.js";
import {
  buildDedicatedConnectionString,
  dedicatedDatabaseName,
  resolveTenantStorageTarget,
} from "./tenant-storage.js";
import type { EvalTraceRecord } from "./types.js";
import type { CreateTenantInput } from "./types.js";
import { decodeState, type StoreState } from "./persistent-state.js";
import { insertTrace, readTraces, readLatestPinTrace } from "./postgres-traces.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function sanitizeSchemaName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface PostgresResources {
  pool: pg.Pool;
  leasePool: pg.Pool;
  dedicatedPools: Map<string, pg.Pool>;
  entityOwners: Map<string, string>;
  profileOwners: Map<string, string>;
  ready: boolean;
  initializing?: Promise<void>;
  closing: boolean;
  closed?: Promise<void>;
  pending: Set<Promise<unknown>>;
  queues: Map<string, Promise<void>>;
  active: number;
  slots: Array<() => void>;
}

/** Fresh business maps and transaction state for exactly one catalog operation. */
class PostgresCatalog extends MemoryStore {
  private transactionClients?: Map<pg.Pool, pg.PoolClient>;
  // Capture the actual stored JSON, including fields the current model does not
  // materialize. Reconstructing tenantState is not a valid CAS expectation.
  private restoredCatalogs = new Map<string, unknown>();
  constructor(private connectionString: string, private resources: PostgresResources) { super(); }
  private get pool() { return this.resources.pool; }
  private get leasePool() { return this.resources.leasePool; }
  private get dedicatedPools() { return this.resources.dedicatedPools; }
  private get entityOwners() { return this.resources.entityOwners; }
  private get platformReady() { return this.resources.ready; }
  private set platformReady(value: boolean) { this.resources.ready = value; }

  async init(): Promise<void> {
    if (this.platformReady) return;
    if (!this.resources.initializing) this.resources.initializing = this.migrate().finally(() => { this.resources.initializing = undefined; });
    return this.resources.initializing;
  }

  private async migrate(): Promise<void> {
    const lock = await this.pool.connect();
    let failed: Error | undefined;
    try {
      await lock.query("SET statement_timeout = '30s'");
      await lock.query("SELECT pg_advisory_lock(7318520)");
      const sql = readFileSync(join(__dirname, "../migrations/001_platform.sql"), "utf8");
      await this.pool.query(sql);
      await this.pool.query("CREATE UNIQUE INDEX IF NOT EXISTS tenants_schema_unique ON platform.tenants (db_schema)");
      await this.pool.query(`CREATE TABLE IF NOT EXISTS platform.catalog_state (id TEXT PRIMARY KEY, payload JSONB NOT NULL)`);
      await this.restoreCatalogs(true);
      this.platformReady = true;
    } finally {
      try { await lock.query("SELECT pg_advisory_unlock(7318520)"); }
      catch (error) { failed = error as Error; throw error; }
      finally { lock.release(failed); }
    }
  }
  override async health():Promise<void>{await this.pool.query("SELECT 1");}

  override async createTenant(input: CreateTenantInput): Promise<Tenant> {
    if (!this.platformReady) await this.init();
    const tenant = await super.createTenant(input);
    if (tenant.isolationMode === "dedicated") {
      const dbName = dedicatedDatabaseName(tenant.id);
      let databaseCreated = false;
      let dedicatedPool: pg.Pool | undefined;
      try {
        await this.pool.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
        databaseCreated = true;
        const dedicatedUrl = buildDedicatedConnectionString(this.connectionString, dbName);
        dedicatedPool = new pg.Pool({ connectionString: dedicatedUrl, connectionTimeoutMillis: 10_000 });
        await this.applyTenantSchemaOnPool(dedicatedPool, "public");
        // Publish routing only when the isolated database is ready.
        await this.pool.query(
          `INSERT INTO platform.tenants (id, name, db_schema, isolation_mode, gateway, dedicated_database_url)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenant.id, tenant.name, dbName, tenant.isolationMode, JSON.stringify(tenant.gateway), dedicatedUrl],
        );
        this.dedicatedPools.set(tenant.id, dedicatedPool);
        const created = { ...tenant, dbSchema: dbName, dedicatedDatabaseUrl: dedicatedUrl };
        this.tenants.set(created.id, created);
        return created;
      } catch (error) {
        this.tenants.delete(tenant.id);
        await dedicatedPool?.end();
        if (databaseCreated) await this.pool.query(`DROP DATABASE ${quoteIdent(dbName)}`).catch(() => {});
        throw error;
      }
    }

    const schema = sanitizeSchemaName(tenant.dbSchema);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
      await this.applyTenantSchemaOnPool(client, schema);
      await client.query(
        `INSERT INTO platform.tenants (id, name, db_schema, isolation_mode, gateway, dedicated_database_url)
         VALUES ($1, $2, $3, $4, $5, NULL)`,
        [tenant.id, tenant.name, schema, tenant.isolationMode, JSON.stringify(tenant.gateway)],
      );
      await client.query("COMMIT");
      const created = { ...tenant, dbSchema: schema };
      this.tenants.set(created.id, created);
      return created;
    } catch (error) {
      await client.query("ROLLBACK");
      this.tenants.delete(tenant.id);
      throw error;
    } finally { client.release(); }
  }

  override async updateTenantGateway(
    id: Tenant["id"],
    gateway: TenantGateway,
  ): Promise<Tenant | null> {
    const updated = await super.updateTenantGateway(id, gateway);
    if (!updated) return null;
    await this.businessQuery(this.pool, `UPDATE platform.tenants SET gateway = $2 WHERE id = $1`, [
      id,
      JSON.stringify(gateway),
    ]);
    return updated;
  }

  private async applyTenantSchemaOnPool(pool: pg.Pool | pg.PoolClient, schema: string): Promise<void> {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    if (schema !== "public") {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    }
    const template = readFileSync(join(__dirname, "../migrations/tenant_schema.sql"), "utf8");
    const tenantSql = template.replaceAll(":schema", quoteIdent(schema));
    for (const stmt of tenantSql.split(";").filter((s) => s.trim())) {
      await pool.query(stmt);
    }
  }

  private async restoreCatalogs(migrate = false, tenantId?: string, method?: string): Promise<void> {
    const marketplaceOnly = ["publishMarketplaceSkill", "listMarketplaceSkills", "getMarketplaceSkill"].includes(method ?? "");
    const metadataOnly = ["createTenant", "listTenants", "getTenant", "updateTenantGateway", "saveTrace", "listTraces", "appendAudit", "listAuditLog"].includes(method ?? "");
    const tenants = marketplaceOnly ? { rows: [] } : await this.pool.query(tenantId ? "SELECT * FROM platform.tenants WHERE id = $1" : "SELECT * FROM platform.tenants", tenantId ? [tenantId] : undefined);
    this.tenants.clear();
    this.resetPersistentState();
    for (const row of tenants.rows) {
      const tenant: Tenant = { id: row.id, name: row.name, dbSchema: row.db_schema, isolationMode: row.isolation_mode,
        gateway: row.gateway, dedicatedDatabaseUrl: row.dedicated_database_url ?? undefined, createdAt: row.created_at };
      this.tenants.set(tenant.id, tenant);
      this.entityOwners.set(tenant.id, tenant.id);
      if (tenant.isolationMode === "dedicated" && !this.dedicatedPools.has(tenant.id)) {
        this.dedicatedPools.set(tenant.id, new pg.Pool({ connectionString: tenant.dedicatedDatabaseUrl }));
      }
      if (metadataOnly && !migrate && (tenantId || !["saveTrace", "listTraces"].includes(method ?? ""))) continue;
      const { pool, schema } = this.resolvePoolAndSchema(tenant);
      if (migrate) await this.applyTenantSchemaOnPool(pool, schema);
      if (migrate) await pool.query(`CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}.catalog_state (id TEXT PRIMARY KEY, payload JSONB NOT NULL)`);
      if (migrate) await this.migrateCheckpointTraces(pool, schema);
      const result = await pool.query(`SELECT payload FROM ${quoteIdent(schema)}.catalog_state WHERE id = 'catalogs'`);
      if (result.rows[0]) this.restoredCatalogs.set(tenant.id, result.rows[0].payload);
      if (result.rows[0]) {
        const state = decodeState(result.rows[0].payload);
        delete state.maps.traces;
        this.restoreTenantState(state);
        for (const [id] of state.maps.profiles ?? []) this.resources.profileOwners.set(id, tenant.id);
        for (const entries of Object.values(state.maps)) for (const [id] of entries) this.entityOwners.set(id, tenant.id);
      }
    }
    const subscribedSkills = this.marketplaceSubscriptions.size > 0 && ["listSkills", "resolveSessionBootstrap"].includes(method ?? "");
    if (!migrate && !subscribedSkills && !["publishMarketplaceSkill", "listMarketplaceSkills", "getMarketplaceSkill", "subscribeMarketplaceSkill", "resolveSkillEvolutionTarget", "createEvolutionRun", "triggerEvolutionSignal"].includes(method ?? "")) return;
    const global = await this.pool.query("SELECT payload FROM platform.catalog_state WHERE id = 'marketplace'");
    if (global.rows[0]) this.restoredCatalogs.set("marketplace", global.rows[0].payload);
    const globalState = decodeState({ maps: { marketplace: global.rows[0]?.payload ?? [] }, warnings: [] });
    this.marketplaceSkills = new Map(globalState.maps.marketplace as Array<[string, import("@diy-agent/domain").MarketplaceSkill]>);
  }

  private operationTenant(method: string | undefined, args: unknown[]): string | undefined {
    if (!method || ["createTenant", "listTenants", "listAllApiKeys", "publishMarketplaceSkill", "listMarketplaceSkills", "getMarketplaceSkill"].includes(method)) return undefined;
    const input = args[0];
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      if (typeof record.tenantId === "string") return record.tenantId;
      for (const field of ["profileId", "workspaceId", "runId"]) {
        if (typeof record[field] === "string") return this.entityOwners.get(record[field]);
      }
    }
    if (typeof input === "string") return this.entityOwners.get(input);
    return undefined;
  }

  private snapshotCatalogs(tenantId?: string): Map<string, string> {
    const snapshots = new Map<string, string>();
    for (const tenant of this.tenants.values()) {
      if (tenantId && tenant.id !== tenantId) continue;
      snapshots.set(tenant.id, JSON.stringify(this.tenantState(tenant.id)));
    }
    snapshots.set("marketplace", JSON.stringify([...this.marketplaceSkills]));
    return snapshots;
  }

  /** Each business operation may commit to only one physical database. */
  private async businessQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(pool: pg.Pool, sql: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
    if (!this.transactionClients) return pool.query<R>(sql, params);
    let client = this.transactionClients.get(pool);
    if (!client) {
      if (this.transactionClients.size) throw new Error("cross_database_transaction_not_supported");
      client = await pool.connect();
      this.transactionClients.set(pool, client);
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '30s'");
    }
    return client.query<R>(sql, params);
  }

  private async saveCatalogs(before: Map<string, string>, tenantId?: string): Promise<void> {
    for (const tenant of this.tenants.values()) {
      if (tenantId && tenant.id !== tenantId) continue;
      const payload = JSON.stringify(this.tenantState(tenant.id));
      if (before.get(tenant.id) === payload) continue;
      const { pool, schema } = this.resolvePoolAndSchema(tenant);
      await this.compareAndSaveCatalog(pool, `${quoteIdent(schema)}.catalog_state`, "catalogs", tenant.id, payload);
    }
    const marketplace = JSON.stringify([...this.marketplaceSkills]);
    if (before.get("marketplace") !== marketplace) await this.compareAndSaveCatalog(this.pool, "platform.catalog_state", "marketplace", "marketplace", marketplace);
  }

  private async compareAndSaveCatalog(pool: pg.Pool, table: string, id: string, key: string, payload: string): Promise<void> {
    // Advisory locks reduce contention, but their connection may fail while the
    // independent business transaction is alive. SQL CAS is the final fence;
    // a stale writer rolls back its entire transaction, including audit records.
    const result = this.restoredCatalogs.has(key)
      ? await this.businessQuery(pool, `UPDATE ${table} SET payload = $2::jsonb WHERE id = $1 AND payload = $3::jsonb RETURNING id`,
        [id, payload, JSON.stringify(this.restoredCatalogs.get(key))])
      : await this.businessQuery(pool, `INSERT INTO ${table} (id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`, [id, payload]);
    if (result.rowCount !== 1) throw new Error("catalog_write_conflict");
  }

  /** The proxy delegates into an unproxied operation context, so nested store calls share one lock. */
  async catalogOperation<T>(_operation: () => Promise<T>, write: boolean, method?: string, args: unknown[] = []): Promise<T> {
    if (!method) throw new Error("catalog_method_required");
    if (this.resources.closing) throw new Error("store_closed");
    const task = (async () => {
      await this.init();
      const tenantId = this.operationTenant(method, args);
      const queueKey = tenantId ?? "global";
      const previous = this.resources.queues.get(queueKey) ?? Promise.resolve();
      let done!: () => void;
      const queued = new Promise<void>(resolve => { done = resolve; });
      this.resources.queues.set(queueKey, queued);
      await previous;
      if (this.resources.active >= 8) await new Promise<void>(resolve => this.resources.slots.push(resolve));
      else this.resources.active++;
      try {
        const context = new PostgresCatalog(this.connectionString, this.resources);
        return await context.executeOperation<T>(write, method, args, tenantId);
      } finally {
        const next = this.resources.slots.shift();
        if (next) next(); else this.resources.active--;
        done();
        if (this.resources.queues.get(queueKey) === queued) this.resources.queues.delete(queueKey);
      }
    })();
    this.resources.pending.add(task);
    try { return await task; } finally { this.resources.pending.delete(task); }
  }

  private async executeOperation<T>(write: boolean, method: string, args: unknown[], tenantId?: string): Promise<T> {
    let lock: pg.PoolClient | undefined;
    let lockError: Error | undefined;
    const onLockError = (error: Error) => { lockError = error; };
    try {
      if (!this.platformReady) await this.init();
      lock = await this.pool.connect();
      lock.on("error", onLockError);
      await lock.query("SET statement_timeout = '30s'");
      if (tenantId) {
        await lock.query("SELECT pg_advisory_lock_shared(7318520)");
        await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 15485863))", [tenantId]);
      } else await lock.query("SELECT pg_advisory_lock(7318520)");
      await this.restoreCatalogs(false, tenantId, method);
      const sqlOnly = ["createTenant", "updateTenantGateway", "saveTrace", "appendAudit"].includes(method);
      const before = write && !sqlOnly ? this.snapshotCatalogs(tenantId) : undefined;
      // Database provisioning cannot run inside a PostgreSQL transaction.
      if (method !== "createTenant") this.transactionClients = new Map();
      const operation = Reflect.get(this, method) as (...input: unknown[]) => Promise<T>;
      const result = await operation.apply(this, args);
      if (before) await this.saveCatalogs(before, tenantId);
      if (lockError) throw new Error("catalog_lock_connection_lost", { cause: lockError });
      await lock.query("SELECT 1");
      for (const client of this.transactionClients?.values() ?? []) await client.query("COMMIT");
      if (write) for (const tenant of this.tenants.values()) {
        this.entityOwners.set(tenant.id, tenant.id);
        for (const profile of this.profiles.values()) if (this.workspaces.get(profile.workspaceId)?.tenantId === tenant.id) this.resources.profileOwners.set(profile.id, tenant.id);
        for (const entries of Object.values(this.tenantState(tenant.id).maps)) for (const [id] of entries) this.entityOwners.set(id, tenant.id);
      }
      return structuredClone(result);
    } catch (error) {
      for (const [pool, client] of this.transactionClients ?? []) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) { client.release(rollbackError as Error); this.transactionClients?.delete(pool); }
      }
      throw error;
    } finally {
      for (const client of this.transactionClients?.values() ?? []) client.release();
      this.transactionClients = undefined;
      try {
        if (lock && tenantId) {
          await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 15485863))", [tenantId]);
          await lock.query("SELECT pg_advisory_unlock_shared(7318520)");
        } else if (lock) await lock.query("SELECT pg_advisory_unlock(7318520)");
      } catch (error) { lockError = error as Error; throw error; }
      finally { lock?.off("error", onLockError); lock?.release(lockError); }
    }
  }

  override async withLease<T>(key: string, operation: () => Promise<T>): Promise<T | null> {
    if (!key || key.length > 512) throw new Error("invalid_lease_key");
    // Separate pool: a long-running evaluator must not exhaust catalog connections.
    const client = await this.leasePool.connect();
    let acquired = false;
    let connectionError: Error | undefined;
    const onError = (error: Error) => { connectionError = error; };
    client.on("error", onError);
    try {
      const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 982451653)) AS acquired", [key]);
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) return null;
      const value = await operation();
      if (connectionError) throw new Error("lease_connection_lost", { cause: connectionError });
      return value;
    } finally {
      try { if (acquired && !connectionError) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 982451653))", [key]); }
      catch (error) { connectionError = error as Error; throw error; }
      finally { client.off("error", onError); client.release(connectionError); }
    }
  }

  getPool(): pg.Pool {
    return this.pool;
  }

  private resolvePoolAndSchema(tenant: Tenant): { pool: pg.Pool; schema: string } {
    const target = resolveTenantStorageTarget(tenant);
    if (target.dedicated) {
      const pool = this.dedicatedPools.get(tenant.id);
      if (!pool) throw new Error("dedicated_pool_missing");
      return { pool, schema: target.schema };
    }
    return { pool: this.pool, schema: tenant.dbSchema };
  }

  protected override tenantState(tenantId: string): StoreState {
    const state = super.tenantState(tenantId);
    delete state.maps.traces;
    return state;
  }

  private traceTenant(profileId: ProfileId): Tenant | undefined {
    const tenantId = this.resources.profileOwners.get(profileId);
    return tenantId ? this.tenants.get(tenantId) : undefined;
  }

  override async saveTrace(trace: Omit<EvalTraceRecord, "id" | "createdAt">): Promise<EvalTraceRecord> {
    const tenant = this.traceTenant(trace.profileId);
    if (!tenant) throw new Error("profile_not_found");
    const { pool, schema } = this.resolvePoolAndSchema(tenant);
    const schemaIdent = quoteIdent(schema);
    const entry: EvalTraceRecord = { ...trace, id: crypto.randomUUID(), createdAt: new Date() };
    await this.lockProfileEvidence(pool, trace.profileId);
    await this.businessQuery(pool, `DELETE FROM ${schemaIdent}.eval_traces WHERE profile_id = $1 AND created_at < NOW() - INTERVAL '90 days'`, [trace.profileId]);
    await insertTrace((sql, params) => this.businessQuery(pool, sql, params), schemaIdent, entry);
    return entry;
  }

  override async listTraces(profileId: ProfileId, limit = 50): Promise<EvalTraceRecord[]> {
    const tenant = this.traceTenant(profileId);
    if (!tenant) return [];
    const { pool, schema } = this.resolvePoolAndSchema(tenant);
    return readTraces((sql, params) => pool.query(sql, params), quoteIdent(schema), profileId, limit);
  }

  protected override async latestPinTrace(profileId: ProfileId, versionId: EvalTraceRecord["profileVersionId"]): Promise<EvalTraceRecord | undefined> {
    const tenant = this.traceTenant(profileId);
    if (!tenant) return undefined;
    const { pool, schema } = this.resolvePoolAndSchema(tenant);
    await this.lockProfileEvidence(pool, profileId);
    return readLatestPinTrace((sql, params) => this.businessQuery(pool, sql, params), quoteIdent(schema), profileId, versionId);
  }

  private async lockProfileEvidence(pool: pg.Pool, profileId: ProfileId): Promise<void> {
    if (!this.transactionClients) throw new Error("evidence_transaction_required");
    // Profile UUIDs are globally unique. The lock lives on the physical tenant
    // database and the very transaction that reads evidence and commits pinning.
    await this.businessQuery(pool, "SELECT pg_advisory_xact_lock(hashtextextended($1, 32452843))", [profileId]);
  }

  /** Legacy checkpoint import is atomic and refuses contradictory duplicate trace IDs. */
  private async migrateCheckpointTraces(pool: pg.Pool, schema: string): Promise<void> {
    const client = await pool.connect();
    const schemaIdent = quoteIdent(schema);
    try {
      await client.query("BEGIN");
      const result = await client.query(`SELECT payload FROM ${schemaIdent}.catalog_state WHERE id='catalogs' FOR UPDATE`);
      const payload = result.rows[0]?.payload;
      if (payload?.maps && Object.hasOwn(payload.maps, "traces")) {
        const state = decodeState(payload);
        const profiles = new Set((state.maps.profiles ?? []).map(([id]) => id));
        for (const [, raw] of state.maps.traces ?? []) {
          const trace = raw as EvalTraceRecord;
          if (!profiles.has(trace.profileId)) throw new Error("legacy_trace_owner_mismatch");
          await insertTrace((sql, params) => client.query(sql, params), schemaIdent, trace, true);
        }
        await client.query(`UPDATE ${schemaIdent}.catalog_state SET payload=payload #- '{maps,traces}' WHERE id='catalogs'`);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  override async appendAudit(event: Omit<AuditEvent, "id" | "createdAt">): Promise<AuditEvent> {
    const record = await super.appendAudit(event);
    const tenant = await this.getTenant(event.tenantId);
    if (tenant) {
      const { pool, schema } = this.resolvePoolAndSchema(tenant);
      const schemaIdent = quoteIdent(schema);
      await this.businessQuery(pool,
        `INSERT INTO ${schemaIdent}.audit_log (id, tenant_id, workspace_id, action, actor, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          record.id,
          record.tenantId,
          record.workspaceId ?? null,
          record.action,
          record.actor ?? null,
          JSON.stringify(record.metadata ?? {}),
          record.createdAt,
        ],
      );
    }
    return record;
  }

  override async listAuditLog(tenantId: TenantId, limit = 100): Promise<AuditEvent[]> {
    const tenant = await this.getTenant(tenantId);
    if (tenant) {
      const { pool, schema } = this.resolvePoolAndSchema(tenant);
      const schemaIdent = quoteIdent(schema);
      const result = await pool.query<{
        id: string;
        tenant_id: string;
        workspace_id: string | null;
        action: string;
        actor: string | null;
        metadata: Record<string, unknown> | null;
        created_at: Date;
      }>(
        `SELECT id, tenant_id, workspace_id, action, actor, metadata, created_at
         FROM ${schemaIdent}.audit_log
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [tenantId, limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id as TenantId,
        workspaceId: row.workspace_id as import("@diy-agent/domain").WorkspaceId | undefined,
        action: row.action,
        actor: row.actor ?? undefined,
        metadata: row.metadata ?? undefined,
        createdAt: row.created_at,
      }));
    }
    return super.listAuditLog(tenantId, limit);
  }

  override async close(): Promise<void> {
    if (this.resources.closed) return this.resources.closed;
    this.resources.closing = true;
    this.resources.closed = (async () => {
      await Promise.allSettled([...this.resources.pending]);
      for (const pool of this.dedicatedPools.values()) await pool.end();
      this.dedicatedPools.clear();
      await this.pool.end();
      await this.leasePool.end();
    })();
    return this.resources.closed;
  }
}

/** Public facade owns shared pools and routes every operation into a fresh catalog context. */
export class PostgresStore extends PostgresCatalog {
  constructor(connectionString: string) {
    super(connectionString, {
      pool: new pg.Pool({ connectionString, max: 24, connectionTimeoutMillis: 10_000, statement_timeout: 30000, query_timeout: 35000 }),
      leasePool: new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10_000 }),
      dedicatedPools: new Map(), entityOwners: new Map(), profileOwners: new Map(), ready: false, closing: false,
      pending: new Set(), queues: new Map(), active: 0, slots: [],
    });
    return new Proxy(this, { get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (typeof property !== "string" || ["init", "close", "getPool", "catalogOperation", "withLease", "health"].includes(property)) return value.bind(target);
      return (...args: unknown[]) => target.catalogOperation(() => value.apply(target, args),
        property === "resolveSessionBootstrap" ? args[2] === true : !/^(get|list|resolve)/.test(property), property, args);
    } });
  }
}

export async function createStore(connectionString?: string): Promise<MemoryStore> {
  if (connectionString) {
    const store = new PostgresStore(connectionString);
    try { await store.init(); }
    catch (error) { await store.close(); throw error; }
    return store;
  }
  return new MemoryStore();
}
