import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AuditEvent, ProfileId, Tenant, TenantGateway, TenantId } from "@diy-agent/domain";
import { isTraceExpired } from "@diy-agent/domain";
import { MemoryStore } from "./memory-store.js";
import {
  buildDedicatedConnectionString,
  dedicatedDatabaseName,
  resolveTenantStorageTarget,
} from "./tenant-storage.js";
import type { EvalTraceRecord } from "./types.js";
import type { CreateTenantInput } from "./types.js";
import { decodeState } from "./persistent-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function sanitizeSchemaName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class PostgresStore extends MemoryStore {
  private pool: pg.Pool;
  private platformReady = false;
  private dedicatedPools = new Map<string, pg.Pool>();
  private operationQueue: Promise<void> = Promise.resolve();
  private transactionClients?: Map<pg.Pool, pg.PoolClient>;
  private readonly leasePool: pg.Pool;
  private readonly entityOwners = new Map<string, string>();

  constructor(private connectionString: string) {
    super();
    this.pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout:30000,query_timeout:35000 });
    this.leasePool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10_000 });
    // All public construction paths must use the same durability boundary.
    return new Proxy(this, { get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (typeof property !== "string" || ["init", "close", "getPool", "catalogOperation", "withLease","health"].includes(property)) return value.bind(target);
      return (...args: unknown[]) => target.catalogOperation(() => value.apply(target, args), !/^(get|list|resolve)/.test(property), property, args);
    } });
  }

  async init(): Promise<void> {
    if (this.platformReady) return;
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

  private async restoreCatalogs(migrate = false, tenantId?: string): Promise<void> {
    const tenants = await this.pool.query("SELECT * FROM platform.tenants");
    this.tenants.clear();
    this.resetPersistentState();
    for (const row of tenants.rows) {
      const tenant: Tenant = { id: row.id, name: row.name, dbSchema: row.db_schema, isolationMode: row.isolation_mode,
        gateway: row.gateway, dedicatedDatabaseUrl: row.dedicated_database_url ?? undefined, createdAt: row.created_at };
      this.tenants.set(tenant.id, tenant);
      if (tenant.isolationMode === "dedicated" && !this.dedicatedPools.has(tenant.id)) {
        this.dedicatedPools.set(tenant.id, new pg.Pool({ connectionString: tenant.dedicatedDatabaseUrl }));
      }
      if (tenantId && tenant.id !== tenantId) continue;
      const { pool, schema } = this.resolvePoolAndSchema(tenant);
      if (migrate) await this.applyTenantSchemaOnPool(pool, schema);
      if (migrate) await pool.query(`CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}.catalog_state (id TEXT PRIMARY KEY, payload JSONB NOT NULL)`);
      const result = await pool.query(`SELECT payload FROM ${quoteIdent(schema)}.catalog_state WHERE id = 'catalogs'`);
      if (result.rows[0]) {
        const state = decodeState(result.rows[0].payload);
        this.restoreTenantState(state);
        for (const entries of Object.values(state.maps)) for (const [id] of entries) this.entityOwners.set(id, tenant.id);
      }
    }
    const global = await this.pool.query("SELECT payload FROM platform.catalog_state WHERE id = 'marketplace'");
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
    if (typeof input === "string") return this.tenants.has(input) ? input : this.entityOwners.get(input);
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
      await this.businessQuery(pool, `INSERT INTO ${quoteIdent(schema)}.catalog_state (id, payload) VALUES ('catalogs', $1::jsonb)
        ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`, [payload]);
    }
    const marketplace = JSON.stringify([...this.marketplaceSkills]);
    if (before.get("marketplace") !== marketplace) await this.businessQuery(this.pool, `INSERT INTO platform.catalog_state (id, payload) VALUES ('marketplace', $1::jsonb)
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`, [marketplace]);
  }

  /** Keeps legacy aggregate semantics serializable; only dirty partitions are written. */
  async catalogOperation<T>(operation: () => Promise<T>, write: boolean, method?: string, args: unknown[] = []): Promise<T> {
    const previous = this.operationQueue;
    let done!: () => void;
    this.operationQueue = new Promise<void>(resolve => { done = resolve; });
    await previous;
    let lock: pg.PoolClient | undefined;
    const tenantId = this.operationTenant(method, args);
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
      await this.restoreCatalogs(false, tenantId);
      const before = this.snapshotCatalogs(tenantId);
      // Database provisioning cannot run inside a PostgreSQL transaction.
      if (method !== "createTenant") this.transactionClients = new Map();
      const result = await operation();
      if (write && method !== "createTenant") await this.saveCatalogs(before, tenantId);
      if (lockError) throw new Error("catalog_lock_connection_lost", { cause: lockError });
      await lock.query("SELECT 1");
      for (const client of this.transactionClients?.values() ?? []) await client.query("COMMIT");
      for (const tenant of this.tenants.values()) {
        if (tenantId && tenant.id !== tenantId) continue;
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
      finally { lock?.off("error", onLockError); lock?.release(lockError); done(); }
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

  override async saveTrace(trace: Omit<EvalTraceRecord, "id" | "createdAt">): Promise<EvalTraceRecord> {
    const tenant = await this.getTenantForProfile(trace.profileId);
    if (tenant) {
      await this.purgeExpiredTracesForTenant(tenant);
      const entry = await super.saveTrace(trace);
      const { pool, schema } = this.resolvePoolAndSchema(tenant);
      const schemaIdent = quoteIdent(schema);
      await this.businessQuery(pool,
        `INSERT INTO ${schemaIdent}.eval_traces (id, profile_id, profile_version_id, output, latency_ms, tool_calls, tokens_used, created_at, task_id, eval_batch_id, task_set_hash, execution_source, eval_scope)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)`,
        [
          entry.id,
          entry.profileId,
          entry.profileVersionId,
          entry.output,
          entry.latencyMs,
          JSON.stringify(entry.toolCalls ?? []),
          entry.tokensUsed ?? null,
          entry.createdAt,
          entry.taskId ?? null,
          entry.evalBatchId ?? null,
          entry.taskSetHash ?? null,
          entry.executionSource ?? null,
          entry.evalScope ?? null,
        ],
      );
      return entry;
    }
    return super.saveTrace(trace);
  }

  override async listTraces(profileId: ProfileId, limit = 50): Promise<EvalTraceRecord[]> {
    const tenant = await this.getTenantForProfile(profileId);
    if (tenant) {
      const { pool, schema } = this.resolvePoolAndSchema(tenant);
      const schemaIdent = quoteIdent(schema);
      const result = await pool.query<{
        id: string;
        profile_id: string;
        profile_version_id: string;
        output: string;
        latency_ms: number;
        tool_calls: EvalTraceRecord["toolCalls"];
        tokens_used: number | null;
        task_id: string | null;
        eval_batch_id: string | null;
        task_set_hash: string | null;
        execution_source: EvalTraceRecord["executionSource"] | null;
        eval_scope: EvalTraceRecord["evalScope"] | null;
        created_at: Date;
      }>(
        `SELECT id, profile_id, profile_version_id, output, latency_ms, tool_calls, tokens_used, created_at, task_id, eval_batch_id, task_set_hash, execution_source, eval_scope
         FROM ${schemaIdent}.eval_traces
         WHERE profile_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [profileId, limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        profileId: row.profile_id as ProfileId,
        profileVersionId: row.profile_version_id as import("@diy-agent/domain").ProfileVersionId,
        output: row.output,
        latencyMs: row.latency_ms,
        toolCalls: row.tool_calls,
        tokensUsed: row.tokens_used ?? undefined,
        taskId: row.task_id ?? undefined,
        evalBatchId: row.eval_batch_id ?? undefined,
        taskSetHash: row.task_set_hash ?? undefined,
        executionSource: row.execution_source ?? undefined,
        evalScope: row.eval_scope ?? undefined,
        createdAt: row.created_at,
      }));
    }
    return super.listTraces(profileId, limit);
  }

  private async purgeExpiredTracesForTenant(tenant: Tenant): Promise<void> {
    const { pool, schema } = this.resolvePoolAndSchema(tenant);
    const schemaIdent = quoteIdent(schema);
    await this.businessQuery(pool,
      `DELETE FROM ${schemaIdent}.eval_traces WHERE created_at < NOW() - INTERVAL '90 days'`,
    );
    const now = new Date();
    for (const [id, trace] of this.traces) {
      if (this.workspaces.get(this.profiles.get(trace.profileId)?.workspaceId ?? "")?.tenantId === tenant.id && isTraceExpired(trace.createdAt, now)) {
        this.traces.delete(id);
      }
    }
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
    for (const pool of this.dedicatedPools.values()) {
      await pool.end();
    }
    this.dedicatedPools.clear();
    await this.pool.end();
    await this.leasePool.end();
  }
}

export async function createStore(connectionString?: string): Promise<MemoryStore> {
  if (connectionString) {
    const store = new PostgresStore(connectionString);
    await store.init();
    return store;
  }
  return new MemoryStore();
}
