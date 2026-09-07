import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AuditEvent, ProfileId, TenantId } from "@diy-agent/domain";
import { isTraceExpired } from "@diy-agent/domain";
import { MemoryStore } from "./memory-store.js";
import type { EvalTraceRecord } from "./types.js";
import type { CreateTenantInput } from "./types.js";
import type { Tenant, TenantGateway } from "@diy-agent/domain";

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

  constructor(connectionString: string) {
    super();
    this.pool = new pg.Pool({ connectionString });
  }

  async init(): Promise<void> {
    const sql = readFileSync(join(__dirname, "../migrations/001_platform.sql"), "utf8");
    await this.pool.query(sql);
    this.platformReady = true;
  }

  override async createTenant(input: CreateTenantInput): Promise<Tenant> {
    if (!this.platformReady) await this.init();
    const tenant = await super.createTenant(input);
    const schema = sanitizeSchemaName(tenant.dbSchema);
    await this.pool.query(
      `INSERT INTO platform.tenants (id, name, db_schema, isolation_mode, gateway)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenant.id, tenant.name, schema, tenant.isolationMode, JSON.stringify(tenant.gateway)],
    );
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await this.applyTenantSchema(schema);
    return { ...tenant, dbSchema: schema };
  }

  override async updateTenantGateway(
    id: Tenant["id"],
    gateway: TenantGateway,
  ): Promise<Tenant | null> {
    const updated = await super.updateTenantGateway(id, gateway);
    if (!updated) return null;
    await this.pool.query(`UPDATE platform.tenants SET gateway = $2 WHERE id = $1`, [
      id,
      JSON.stringify(gateway),
    ]);
    return updated;
  }

  private async applyTenantSchema(schema: string): Promise<void> {
    const template = readFileSync(join(__dirname, "../migrations/tenant_schema.sql"), "utf8");
    const tenantSql = template.replaceAll(":schema", quoteIdent(schema));
    for (const stmt of tenantSql.split(";").filter((s) => s.trim())) {
      await this.pool.query(stmt);
    }
  }

  getPool(): pg.Pool {
    return this.pool;
  }

  override async saveTrace(trace: Omit<EvalTraceRecord, "id" | "createdAt">): Promise<EvalTraceRecord> {
    const tenant = await this.getTenantForProfile(trace.profileId);
    if (tenant) {
      await this.purgeExpiredTracesInSchema(tenant.dbSchema);
      const entry = await super.saveTrace(trace);
      const schema = quoteIdent(tenant.dbSchema);
      await this.pool.query(
        `INSERT INTO ${schema}.eval_traces (id, profile_id, profile_version_id, output, latency_ms, tool_calls, tokens_used, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          entry.id,
          entry.profileId,
          entry.profileVersionId,
          entry.output,
          entry.latencyMs,
          JSON.stringify(entry.toolCalls ?? []),
          entry.tokensUsed ?? null,
          entry.createdAt,
        ],
      );
      return entry;
    }
    return super.saveTrace(trace);
  }

  override async listTraces(profileId: ProfileId, limit = 50): Promise<EvalTraceRecord[]> {
    const tenant = await this.getTenantForProfile(profileId);
    if (tenant) {
      const schema = quoteIdent(tenant.dbSchema);
      const result = await this.pool.query<{
        id: string;
        profile_id: string;
        profile_version_id: string;
        output: string;
        latency_ms: number;
        tool_calls: EvalTraceRecord["toolCalls"];
        tokens_used: number | null;
        created_at: Date;
      }>(
        `SELECT id, profile_id, profile_version_id, output, latency_ms, tool_calls, tokens_used, created_at
         FROM ${schema}.eval_traces
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
        createdAt: row.created_at,
      }));
    }
    return super.listTraces(profileId, limit);
  }

  private async purgeExpiredTracesInSchema(schemaName: string): Promise<void> {
    const schema = quoteIdent(schemaName);
    await this.pool.query(`DELETE FROM ${schema}.eval_traces WHERE created_at < NOW() - INTERVAL '90 days'`);
    const now = new Date();
    for (const [id, trace] of this.traces) {
      if (isTraceExpired(trace.createdAt, now)) {
        this.traces.delete(id);
      }
    }
  }

  override async appendAudit(event: Omit<AuditEvent, "id" | "createdAt">): Promise<AuditEvent> {
    const record = await super.appendAudit(event);
    const tenant = await this.getTenant(event.tenantId);
    if (tenant) {
      const schema = quoteIdent(tenant.dbSchema);
      await this.pool.query(
        `INSERT INTO ${schema}.audit_log (id, tenant_id, workspace_id, action, actor, metadata, created_at)
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
      const schema = quoteIdent(tenant.dbSchema);
      const result = await this.pool.query<{
        id: string;
        tenant_id: string;
        workspace_id: string | null;
        action: string;
        actor: string | null;
        metadata: Record<string, unknown> | null;
        created_at: Date;
      }>(
        `SELECT id, tenant_id, workspace_id, action, actor, metadata, created_at
         FROM ${schema}.audit_log
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
    await this.pool.end();
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
