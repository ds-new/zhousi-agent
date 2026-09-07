import type { Tenant } from "@diy-agent/domain";

export interface TenantStorageTarget {
  schema: string;
  dedicated: boolean;
}

/** Resolve Postgres schema vs dedicated-database target for a tenant. */
export function resolveTenantStorageTarget(tenant: Tenant): TenantStorageTarget {
  if (tenant.isolationMode === "dedicated") {
    return { schema: "public", dedicated: true };
  }
  return { schema: tenant.dbSchema, dedicated: false };
}

export function dedicatedDatabaseName(tenantId: string): string {
  return `diy_t_${tenantId.replace(/-/g, "").slice(0, 16)}`;
}

export function buildDedicatedConnectionString(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}
