/**
 * MCP warm connection pool with tenant/workspace/session scope.
 */
import {
  DEFAULT_MAX_WARM_MCP_CONNECTIONS,
  resolveMcpPoolScope,
  shouldWarmPool,
  type McpBinding,
} from "@diy-agent/domain";

export const name = "@diy-agent/dsh-mcp-pool-plugin";
export const inject = ["tools"] as const;

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
  scope: string;
  lastUsedAt: number;
  handle: symbol;
}

const pool = new Map<string, PooledConnection>();
let maxPerTenant = DEFAULT_MAX_WARM_MCP_CONNECTIONS;

export function apply(_ctx: unknown, config: McpPoolConfig): void {
  maxPerTenant = config.maxConnectionsPerTenant ?? DEFAULT_MAX_WARM_MCP_CONNECTIONS;
  startIdleReaper(config.idleTimeoutMs);
}

export function acquire(binding: McpBinding, ctx: PoolContext = {}): PooledConnection {
  if (!shouldWarmPool(binding)) {
    return {
      serverName: binding.serverName,
      scope: "session",
      lastUsedAt: Date.now(),
      handle: Symbol(`cold:${binding.serverName}`),
    };
  }

  const tenantConnections = [...pool.values()].filter(
    (c) => ctx.tenantId && c.scope.startsWith(`tenant:${ctx.tenantId}`),
  ).length;
  if (tenantConnections >= maxPerTenant) {
    throw new Error("mcp_warm_pool_limit_exceeded");
  }

  const key = poolKey(binding, ctx);
  const existing = pool.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  const scope = resolveMcpPoolScope(binding);
  const conn: PooledConnection = {
    serverName: binding.serverName,
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
  const scopeId =
    scope === "tenant"
      ? (ctx.tenantId ?? "unknown-tenant")
      : scope === "session"
        ? (ctx.sessionId ?? "unknown-session")
        : (ctx.workspaceId ?? "unknown-workspace");
  return `${scope}:${scopeId}:${binding.serverName}:${binding.transport}:${binding.command ?? binding.url ?? ""}`;
}

function startIdleReaper(idleTimeoutMs: number): void {
  const timer = setInterval(() => {
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
}
