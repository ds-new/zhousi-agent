/**
 * MCP warm connection pool with tenant/workspace/session scope.
 */

import { resolveMcpPoolScope, type McpBinding } from "@diy-agent/domain";

export const name = "@diy-agent/dsh-mcp-pool-plugin";
export const inject = ["tools"] as const;

export interface McpPoolConfig {
  warmPoolDefault: boolean;
  idleTimeoutMs: number;
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

export function apply(_ctx: unknown, config: McpPoolConfig): void {
  startIdleReaper(config.idleTimeoutMs);
}

export function acquire(
  binding: McpBinding,
  ctx: PoolContext = {}
): PooledConnection {
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

export function release(
  binding: McpBinding,
  ctx: PoolContext = {}
): void {
  if (binding.warmPool ?? true) return;
  pool.delete(poolKey(binding, ctx));
}

export function poolKey(binding: McpBinding, ctx: PoolContext): string {
  const scope = resolveMcpPoolScope(binding);
  const scopeId =
    scope === "tenant"
      ? ctx.tenantId ?? "unknown-tenant"
      : scope === "session"
        ? ctx.sessionId ?? "unknown-session"
        : ctx.workspaceId ?? "unknown-workspace";

  return `${scope}:${scopeId}:${binding.serverName}:${binding.transport}:${binding.command ?? binding.url ?? ""}`;
}

function startIdleReaper(idleTimeoutMs: number): void {
  setInterval(() => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const [key, conn] of pool) {
      if (conn.lastUsedAt < cutoff) pool.delete(key);
    }
  }, Math.min(idleTimeoutMs, 60_000)).unref?.();
}

export function getPoolSize(): number {
  return pool.size;
}
