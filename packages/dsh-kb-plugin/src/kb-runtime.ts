import type { KnowledgeBaseConfig, TenantId, WorkspaceId } from "@diy-agent/domain";
import {
  HybridKbService,
  InternalKbStore,
  PostgresKbStore,
  type KbDocument,
  type KbSearchResult,
  type KbStore,
  type McpKbSearchClient,
} from "@diy-agent/kb-rag";
import pg from "pg";

export interface KbRuntimeSearchInput {
  workspaceId: WorkspaceId;
  query: string;
  kbConfig: KnowledgeBaseConfig;
  tenantId?: TenantId;
}

export interface KbRuntimeIngestInput {
  workspaceId: WorkspaceId;
  title: string;
  content: string;
  kbConfig: KnowledgeBaseConfig;
  tenantId?: TenantId;
}

export interface KbRuntimeDeps {
  mcpKbSearchClient?: McpKbSearchClient;
  internalStore?: KbStore;
  databaseUrl?: string;
  tenantDbSchema?: string;
  dedicatedDatabaseUrl?: string;
}

export interface KbRuntime {
  search(input: KbRuntimeSearchInput): Promise<KbSearchResult>;
  ingest(input: KbRuntimeIngestInput): Promise<KbDocument | null>;
}

let sharedPool: pg.Pool | null = null;
let sharedPoolKey: string | null = null;

export function resetKbRuntimeForTests(): void {
  sharedPool = null;
  sharedPoolKey = null;
}

export function createKbRuntime(deps: KbRuntimeDeps = {}): KbRuntime {
  const services = new Map<string, HybridKbService>();

  function serviceKey(kbConfig: KnowledgeBaseConfig, tenantId?: TenantId, workspaceId?: WorkspaceId): string {
    return JSON.stringify({ kbConfig, tenantId, workspaceId });
  }

  function resolveInternalStore(): KbStore {
    if (deps.internalStore) return deps.internalStore;

    const dedicatedUrl = deps.dedicatedDatabaseUrl ?? process.env.DIY_DEDICATED_DATABASE_URL;
    if (dedicatedUrl) {
      return new PostgresKbStore(getOrCreatePool(dedicatedUrl), "public");
    }

    const databaseUrl = deps.databaseUrl ?? process.env.DIY_DATABASE_URL;
    const schema = deps.tenantDbSchema ?? process.env.DIY_TENANT_DB_SCHEMA;
    if (databaseUrl && schema) {
      return new PostgresKbStore(getOrCreatePool(databaseUrl), schema);
    }

    return new InternalKbStore();
  }

  function getService(
    kbConfig: KnowledgeBaseConfig,
    tenantId?: TenantId,
    workspaceId?: WorkspaceId,
  ): HybridKbService {
    const key = serviceKey(kbConfig, tenantId, workspaceId);
    let svc = services.get(key);
    if (!svc) {
      svc = new HybridKbService(
        kbConfig,
        resolveInternalStore(),
        deps.mcpKbSearchClient,
        tenantId ? { tenantId, workspaceId } : { workspaceId },
      );
      services.set(key, svc);
    }
    return svc;
  }

  return {
    async search(input) {
      const svc = getService(input.kbConfig, input.tenantId, input.workspaceId);
      return svc.search(input.workspaceId, input.query);
    },
    async ingest(input) {
      const svc = getService(input.kbConfig, input.tenantId, input.workspaceId);
      return svc.ingest(input.workspaceId, input.title, input.content);
    },
  };
}

function getOrCreatePool(connectionString: string): pg.Pool {
  if (sharedPool && sharedPoolKey === connectionString) return sharedPool;
  sharedPool = new pg.Pool({ connectionString });
  sharedPoolKey = connectionString;
  return sharedPool;
}
