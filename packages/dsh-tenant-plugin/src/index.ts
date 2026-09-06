/**
 * Tenant/Workspace context injection for DSH sessions.
 * Maps DSH session meta → tenant-scoped DB namespace.
 *
 * @see docs/architecture/overview.md
 */

export const name = "@diy-agent/dsh-tenant-plugin";
export const inject = ["sessions"] as const;

export interface TenantPluginConfig {
  controlPlaneUrl: string;
}

/** Minimal Context shape — replace with @deepseek-ai/cordis when linked */
interface Context {
  sessions: {
    create: (
      id?: string,
      opts?: { meta?: Record<string, unknown> }
    ) => { meta: Record<string, unknown> };
  };
  effect: (fn: () => void | (() => void)) => void;
}

export interface TenantContext {
  tenantId: string;
  workspaceId: string;
  profileId: string;
  profileVersionId: string;
}

const META_KEYS = [
  "diy.tenantId",
  "diy.workspaceId",
  "diy.profileId",
  "diy.profileVersionId",
] as const;

export function apply(ctx: Context, config: TenantPluginConfig): void {
  ctx.effect(() => {
    // Session meta validation hook — reject sessions missing tenant scope
    const originalCreate = ctx.sessions.create.bind(ctx.sessions);
    ctx.sessions.create = (id, opts) => {
      const session = originalCreate(id, opts);
      const meta = session.meta ?? {};
      for (const key of META_KEYS) {
        if (!meta[key]) {
          throw new Error(
            `Session requires ${key}. Create via Control Plane API first.`
          );
        }
      }
      return session;
    };

    return () => {
      ctx.sessions.create = originalCreate;
    };
  });

  void config.controlPlaneUrl;
}

export function extractTenantContext(
  meta: Record<string, unknown>
): TenantContext {
  return {
    tenantId: String(meta["diy.tenantId"]),
    workspaceId: String(meta["diy.workspaceId"]),
    profileId: String(meta["diy.profileId"]),
    profileVersionId: String(meta["diy.profileVersionId"]),
  };
}
