/**
 * Tenant/Workspace context injection for DSH sessions.
 */
export const name = "@diy-agent/dsh-tenant-plugin";
export const inject = ["sessions"] as const;

const META_KEYS = [
  "diy.tenantId",
  "diy.workspaceId",
  "diy.profileId",
  "diy.profileVersionId",
] as const;

interface SessionsService {
  create: (id: string, opts?: { meta?: Record<string, string> }) => unknown;
}

interface Context {
  sessions: SessionsService;
  effect: (fn: () => void | (() => void)) => void;
}

export function validateSessionMeta(meta: Record<string, unknown>): void {
  for (const key of META_KEYS) {
    if (!meta[key]) {
      throw new Error(`Session requires ${key}. Create via Control Plane API first.`);
    }
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const originalCreate = ctx.sessions.create.bind(ctx.sessions);
    ctx.sessions.create = (id, opts) => {
      validateSessionMeta(opts?.meta ?? {});
      return originalCreate(id, opts);
    };
    return () => {
      ctx.sessions.create = originalCreate;
    };
  });
}

export function extractTenantContext(meta: Record<string, unknown>) {
  return {
    tenantId: String(meta["diy.tenantId"]),
    workspaceId: String(meta["diy.workspaceId"]),
    profileId: String(meta["diy.profileId"]),
    profileVersionId: String(meta["diy.profileVersionId"]),
  };
}
