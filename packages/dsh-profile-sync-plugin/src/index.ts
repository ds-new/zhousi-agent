/**
 * Enterprise profile sync — webhook on pin + 5-minute reconcile; offline cache gate.
 */
import {
  PROFILE_SYNC_RECONCILE_INTERVAL_MS,
  type ProfileSyncEntry,
  type ProfileId,
  type ProfileVersionId,
} from "@diy-agent/domain";

export const name = "@diy-agent/dsh-profile-sync-plugin";
export const inject = ["sessions"] as const;

export type { ProfileSyncEntry };

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>;

const cache = new Map<string, ProfileSyncEntry>();

export function profileSyncCacheKey(profileId: string, versionId: string): string {
  return `${profileId}:${versionId}`;
}

export function handleProfilePinnedWebhook(payload: {
  profileId: string;
  versionId: string;
  snapshot?: Record<string, unknown>;
  pinnedAt?: string;
}): ProfileSyncEntry | null {
  if (!payload.snapshot) return null;
  const entry: ProfileSyncEntry = {
    profileId: payload.profileId as ProfileId,
    versionId: payload.versionId as ProfileVersionId,
    snapshot: payload.snapshot,
    pinnedAt: payload.pinnedAt ? new Date(payload.pinnedAt) : new Date(),
  };
  cache.set(profileSyncCacheKey(entry.profileId, entry.versionId), entry);
  return entry;
}

export function getCachedProfileSync(
  profileId: string,
  versionId: string,
): ProfileSyncEntry | null {
  return cache.get(profileSyncCacheKey(profileId, versionId)) ?? null;
}

export async function reconcilePinnedProfiles(
  controlPlaneUrl: string,
  tenantId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<ProfileSyncEntry[]> {
  const res = await fetchImpl(`${controlPlaneUrl.replace(/\/$/, "")}/tenants/${tenantId}/profile-sync`);
  if (!res.ok) {
    throw new Error(`profile_sync_http_${res.status}`);
  }
  const body = (await res.json()) as { profiles: ProfileSyncEntry[] };
  for (const entry of body.profiles ?? []) {
    cache.set(profileSyncCacheKey(entry.profileId, entry.versionId), {
      ...entry,
      pinnedAt: new Date(entry.pinnedAt),
    });
  }
  return body.profiles ?? [];
}

export function assertOfflineSessionAllowed(
  profileId: string,
  versionId: string,
  opts: { offline: boolean; enterpriseMode: boolean },
): void {
  if (!opts.enterpriseMode || !opts.offline) return;
  if (!getCachedProfileSync(profileId, versionId)) {
    throw new Error("profile_sync_cache_miss_offline");
  }
}

let reconcileTimer: ReturnType<typeof setInterval> | undefined;

export function startProfileSyncReconcileLoop(
  controlPlaneUrl: string,
  tenantId: string,
  fetchImpl?: FetchLike,
  intervalMs = PROFILE_SYNC_RECONCILE_INTERVAL_MS,
): () => void {
  stopProfileSyncReconcileLoop();
  void reconcilePinnedProfiles(controlPlaneUrl, tenantId, fetchImpl);
  reconcileTimer = setInterval(() => {
    void reconcilePinnedProfiles(controlPlaneUrl, tenantId, fetchImpl).catch(() => {
      /* offline reconcile retries on next tick */
    });
  }, intervalMs);
  reconcileTimer.unref?.();
  return stopProfileSyncReconcileLoop;
}

export function stopProfileSyncReconcileLoop(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = undefined;
  }
}

export function resetProfileSyncCacheForTests(): void {
  cache.clear();
  stopProfileSyncReconcileLoop();
}

export function apply(
  _ctx: unknown,
  config: { controlPlaneUrl?: string; tenantId?: string; enterpriseMode?: boolean },
): void {
  if (config.enterpriseMode && config.controlPlaneUrl && config.tenantId) {
    startProfileSyncReconcileLoop(config.controlPlaneUrl, config.tenantId);
  }
}
