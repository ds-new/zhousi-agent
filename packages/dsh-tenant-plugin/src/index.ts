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
  create: (id: string, opts?: { meta?: Record<string, string> }) => { meta?: Record<string, string> };
}

interface Context {
  sessions: SessionsService;
  effect: (fn: () => void | (() => void)) => void;
}

export interface ProfileSnapshotResponse {
  snapshot: Record<string, unknown>;
  credentialRefIds: string[];
}

export async function pullProfileSnapshot(
  controlPlaneUrl: string,
  profileId: string,
  versionId: string,
): Promise<ProfileSnapshotResponse | null> {
  try {
    const res = await fetch(`${controlPlaneUrl}/profiles/${profileId}/versions/${versionId}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { snapshot: Record<string, unknown>; credentialRefIds?: string[] };
    return {
      snapshot: body.snapshot,
      credentialRefIds: body.credentialRefIds ?? [],
    };
  } catch {
    return null;
  }
}

const snapshotCache = new Map<string, ProfileSnapshotResponse>();

export function cacheProfileSnapshot(
  profileId: string,
  versionId: string,
  snapshot: ProfileSnapshotResponse,
): void {
  snapshotCache.set(`${profileId}:${versionId}`, snapshot);
}

export function getCachedProfileSnapshot(
  profileId: string,
  versionId: string,
): ProfileSnapshotResponse | null {
  return snapshotCache.get(`${profileId}:${versionId}`) ?? null;
}

export function apply(ctx: Context, config: { controlPlaneUrl?: string }): void {
  const controlPlaneUrl = config.controlPlaneUrl ?? process.env.DIY_CONTROL_PLANE_URL ?? "http://127.0.0.1:9878";

  ctx.effect(() => {
    const originalCreate = ctx.sessions.create.bind(ctx.sessions);
    ctx.sessions.create = (id, opts) => {
      const meta = opts?.meta ?? {};
      for (const key of META_KEYS) {
        if (!meta[key]) {
          throw new Error(`Session requires ${key}. Create via Control Plane API first.`);
        }
      }
      const profileId = String(meta["diy.profileId"]);
      const versionId = String(meta["diy.profileVersionId"]);
      void pullProfileSnapshot(controlPlaneUrl, profileId, versionId).then((snapshot) => {
        if (snapshot) cacheProfileSnapshot(profileId, versionId, snapshot);
      });
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

export function resetSnapshotCacheForTests(): void {
  snapshotCache.clear();
}
