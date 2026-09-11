import { createHash } from "node:crypto";
import type { KnowledgeBaseConfig, TenantId, WorkspaceId } from "@diy-agent/domain";
import {
  HybridKbService,
  InternalKbStore,
  PostgresKbStore,
  ProtocolMcpKbSearchClient,
  type KbDocument,
  type KbSearchResult,
  type KbStore,
  type McpKbSearchClient,
  type McpConnectionOptions,
} from "@diy-agent/kb-rag";
import pg from "pg";

export interface KbRuntimeSearchInput {
  sessionId?: string;
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
  mcpConnectionOptions?: McpConnectionOptions;
  internalStore?: KbStore;
  databaseUrl?: string;
  tenantDbSchema?: string;
  dedicatedDatabaseUrl?: string;
  requireTenant?: boolean;
  /** Trusted application routing, never a request-supplied database URL or schema. */
  resolveTenantDatabase?: (tenantId: TenantId) => Promise<{ databaseUrl: string; schema: string } | null>;
  maxDatabasePools?: number;
  /** Must return exactly 128 finite, nonzero vector values, matching the persisted schema. */
  embeddingProvider?: (text: string, tenantId?: string) => Promise<number[]>;
}

export interface KbRuntime {
  search(input: KbRuntimeSearchInput): Promise<KbSearchResult>;
  ingest(input: KbRuntimeIngestInput): Promise<KbDocument | null>;
  close(): Promise<void>;
}

/** Retained for test compatibility; runtimes no longer share mutable PostgreSQL/MCP pools. */
export function resetKbRuntimeForTests(): void {}

export function createKbRuntime(deps: KbRuntimeDeps = {}): KbRuntime {
  const pools = new Map<string, pg.Pool>();
  const localStore = deps.internalStore ?? new InternalKbStore();
  const ownedMcpClient = deps.mcpKbSearchClient ? undefined : new ProtocolMcpKbSearchClient(undefined, deps.mcpConnectionOptions);
  const mcpClient = deps.mcpKbSearchClient ?? ownedMcpClient!;
  let closed = false;
  if (!Number.isSafeInteger(deps.maxDatabasePools ?? 16) || (deps.maxDatabasePools ?? 16) <= 0) throw new Error("kb_database_pool_limit_invalid");

  function getPool(connectionString: string): pg.Pool {
    let pool = pools.get(connectionString);
    if (!pool) {
      if (pools.size >= (deps.maxDatabasePools ?? 16)) throw new Error("kb_database_pool_limit_exceeded");
      pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 3_000, statement_timeout: 10_000, query_timeout: 12_000 });
      // Idle connection errors are recovered by pg; avoid an unhandled EventEmitter crash.
      pool.on("error", () => {});
      pools.set(connectionString, pool);
    }
    return pool;
  }

  async function resolveInternalStore(tenantId?: TenantId): Promise<KbStore> {
    const embedding = deps.embeddingProvider ? (text: string) => deps.embeddingProvider!(text, tenantId) : undefined;
    if (deps.internalStore) return deps.internalStore;
    if (deps.resolveTenantDatabase) {
      if (!tenantId) throw new Error("kb_tenant_required");
      const route = await deps.resolveTenantDatabase(tenantId);
      if (closed) throw new Error("kb_runtime_closed");
      if (!route) throw new Error("kb_tenant_database_not_configured");
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(route.schema)) throw new Error("kb_tenant_schema_invalid");
      return new PostgresKbStore(getPool(route.databaseUrl), route.schema, embedding);
    }
    const dedicatedUrl = deps.dedicatedDatabaseUrl ?? process.env.DIY_DEDICATED_DATABASE_URL;
    if (dedicatedUrl) return new PostgresKbStore(getPool(dedicatedUrl), "public", embedding);
    const databaseUrl = deps.databaseUrl ?? process.env.DIY_DATABASE_URL;
    const schema = deps.tenantDbSchema ?? process.env.DIY_TENANT_DB_SCHEMA;
    if (databaseUrl && schema) return new PostgresKbStore(getPool(databaseUrl), schema, embedding);
    if (deps.requireTenant) throw new Error("kb_persistent_store_required");
    return embedding ? new InternalKbStore(embedding) : localStore;
  }

  function scopedStore(inner: KbStore, tenantId?: TenantId): KbStore {
    const namespace = (workspaceId: WorkspaceId) => {
      if (!tenantId) return workspaceId;
      const hex = createHash("sha256").update(JSON.stringify([tenantId, workspaceId])).digest("hex").slice(0, 32);
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}` as WorkspaceId;
    };
    return {
      async ingest(input) { const document = await inner.ingest({ ...input, workspaceId: namespace(input.workspaceId) }); return { ...document, workspaceId: input.workspaceId }; },
      search: (workspaceId, query) => inner.search(namespace(workspaceId), query),
    };
  }

  async function getService(kbConfig: KnowledgeBaseConfig, tenantId: TenantId | undefined, workspaceId: WorkspaceId, sessionId?: string): Promise<HybridKbService> {
    if (closed) throw new Error("kb_runtime_closed");
    if (deps.requireTenant && !tenantId?.trim()) throw new Error("kb_tenant_required");
    if (!workspaceId?.trim()) throw new Error("kb_workspace_required");
    // Services are inexpensive and stateless; do not cache unbounded caller-supplied configurations.
    const internal = kbConfig.internal?.enabled ? await resolveInternalStore(tenantId) : localStore;
    if (kbConfig.internal?.enabled && deps.requireTenant && !deps.embeddingProvider) throw new Error("kb_embedding_provider_required");
    return new HybridKbService(kbConfig, scopedStore(internal, tenantId), mcpClient, { tenantId, workspaceId, sessionId });
  }

  return {
    async search(input) {
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 16_384) throw new Error("kb_query_invalid");
      return (await getService(input.kbConfig, input.tenantId, input.workspaceId, input.sessionId)).search(input.workspaceId, input.query);
    },
    async ingest(input) {
      if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 1024 || typeof input.content !== "string" || !input.content.trim() || input.content.length > 1_048_576) throw new Error("kb_document_invalid");
      return (await getService(input.kbConfig, input.tenantId, input.workspaceId)).ingest(input.workspaceId, input.title, input.content);
    },
    async close() {
      closed = true;
      await Promise.allSettled([ownedMcpClient?.close(), ...[...pools.values()].map(pool => pool.end())]);
      pools.clear();
    },
  };
}
