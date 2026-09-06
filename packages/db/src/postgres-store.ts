import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { MemoryStore } from "./memory-store.js";
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
