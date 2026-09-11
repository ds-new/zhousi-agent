/**
 * MCP warm connection pool with tenant/workspace/session scope.
 */
import {
  DEFAULT_MAX_WARM_MCP_CONNECTIONS,
  resolveMcpPoolScope,
  shouldWarmPool,
  type McpBinding,
  type McpCatalogEntry,
} from "@diy-agent/domain";
import { assertMcpCatalogApproved, getActiveBootstrapBundle } from "@diy-agent/dsh-bootstrap-plugin/bundle";

export const name = "@diy-agent/dsh-mcp-pool-plugin";
export const inject = ["tools"] as const;
export { McpConnectionPool, type McpConnectionOptions } from "./connections.js";

export interface McpPoolConfig {
  warmPoolDefault: boolean;
  idleTimeoutMs: number;
  maxConnectionsPerTenant?: number;
}

export interface PoolContext {
  tenantId?: string;
  workspaceId?: string;
  sessionId?: string;
}

interface PooledConnection {
  serverName: string;
  tenantId: string;
  scope: string;
  lastUsedAt: number;
  handle: symbol;
}

const pool = new Map<string, PooledConnection>();
let maxPerTenant = DEFAULT_MAX_WARM_MCP_CONNECTIONS;
let reaper: ReturnType<typeof setInterval> | undefined;

export function apply(_ctx: unknown, config: McpPoolConfig): void {
  maxPerTenant = config.maxConnectionsPerTenant ?? DEFAULT_MAX_WARM_MCP_CONNECTIONS;
  startIdleReaper(config.idleTimeoutMs);
}

export function acquire(binding: McpBinding, ctx: PoolContext = {}): PooledConnection {
  const key = poolKey(binding, ctx);
  const bundle = ctx.workspaceId ? getActiveBootstrapBundle(ctx.workspaceId) : null;
  if (bundle) {
    assertMcpCatalogApproved(binding.serverName, bundle);
  }

  if (!shouldWarmPool(binding)) {
    return {
      serverName: binding.serverName,
      tenantId: ctx.tenantId!,
      scope: "session",
      lastUsedAt: Date.now(),
      handle: Symbol(`cold:${binding.serverName}`),
    };
  }

  const existing = pool.get(key);
  if (existing) { existing.lastUsedAt = Date.now(); return existing; }
  const tenantConnections = [...pool.values()].filter(c => c.tenantId === ctx.tenantId).length;
  if (tenantConnections >= maxPerTenant) throw new Error("mcp_warm_pool_limit_exceeded");

  const scope = resolveMcpPoolScope(binding);
  const conn: PooledConnection = {
    serverName: binding.serverName,
    tenantId: ctx.tenantId!,
    scope,
    lastUsedAt: Date.now(),
    handle: Symbol(`${scope}:${binding.serverName}`),
  };
  pool.set(key, conn);
  return conn;
}

export function release(binding: McpBinding, ctx: PoolContext = {}): void {
  if (shouldWarmPool(binding)) return;
  pool.delete(poolKey(binding, ctx));
}

export function poolKey(binding: McpBinding, ctx: PoolContext): string {
  const scope = resolveMcpPoolScope(binding);
  const required = [ctx.tenantId, ...(scope === "tenant" ? [] : [ctx.workspaceId]), ...(scope === "session" ? [ctx.sessionId] : [])];
  if (required.some(id => typeof id !== "string" || !id.trim())) throw new Error("mcp_scope_context_required");
  return JSON.stringify([scope, ...required, binding.serverName, binding.transport, binding.command, binding.url,
    binding.args ?? [], Object.entries(binding.envRef ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}

function startIdleReaper(idleTimeoutMs: number): void {
  if (reaper) clearInterval(reaper);
  const timer = reaper = setInterval(() => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const [key, conn] of pool) {
      if (conn.lastUsedAt < cutoff) pool.delete(key);
    }
  }, Math.min(idleTimeoutMs, 60_000));
  timer.unref?.();
}

export function getPoolSize(): number {
  return pool.size;
}

export function resetPoolForTests(): void {
  pool.clear();
  if (reaper) clearInterval(reaper);
  reaper = undefined;
}

/** Resolve connection and credential material exclusively from the operator-approved catalog. */
export function resolveApprovedBinding(binding: McpBinding, catalog: McpCatalogEntry): McpBinding {
  if (catalog.approvalStatus !== "approved" || catalog.serverName !== binding.serverName) throw new Error("mcp_catalog_not_approved");
  const approvedRefs = catalog.envRef ?? {};
  const normalize = (refs: Record<string, string>) => JSON.stringify(Object.entries(refs).sort(([a], [b]) => a.localeCompare(b)));
  if (binding.envRef && normalize(binding.envRef) !== normalize(approvedRefs)) throw new Error("mcp_credential_not_approved");
  const sensitivity = catalog.defaultSensitivity === "high" || binding.sensitivity === "high" ? "high" : catalog.defaultSensitivity ?? "normal";
  if (binding.poolScope === "tenant" && sensitivity !== "readonly") throw new Error("mcp_pool_scope_not_allowed");
  return { ...binding, transport: catalog.transport, command: catalog.command, args: catalog.args ? [...catalog.args] : undefined,
    url: catalog.url, envRef: Object.keys(approvedRefs).length ? { ...approvedRefs } : undefined, sensitivity,
    ...(sensitivity === "high" ? { poolScope: "session", warmPool: false } : {}) };
}
