/**
 * Enterprise profile sync — webhook on pin + 5-minute reconcile; offline cache gate.
 */
import {
  PROFILE_SYNC_RECONCILE_INTERVAL_MS,
  defaultWorkspaceAccessPolicy,
  type AccessPolicy,
  type McpCatalogEntry,
  type ProfileSyncEntry,
  type ProfileId,
  type ProfileVersionId,
  type TenantId,
  type WorkspaceId,
} from "@diy-agent/domain";
import {
  getProfileBootstrapBundle,
  materializeProfileBootstrapBundleFromSync,
  storeProfileBootstrapBundle,
} from "@diy-agent/dsh-bootstrap-plugin";

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

export interface ProfilePinnedWebhookPayload {
  profileId: string;
  versionId: string;
  workspaceId: string;
  tenantId: string;
  snapshot?: Record<string, unknown>;
  pinnedAt?: string;
  policy?: AccessPolicy;
  credentialRefIds?: string[];
  mcpCatalog?: McpCatalogEntry[];
}

function normalizeProfileSyncEntry(payload: ProfilePinnedWebhookPayload): ProfileSyncEntry | null {
  if (!payload.snapshot) return null;
  const workspaceId = payload.workspaceId as WorkspaceId;
  return {
    profileId: payload.profileId as ProfileId,
    versionId: payload.versionId as ProfileVersionId,
    workspaceId,
    tenantId: payload.tenantId as TenantId,
    snapshot: payload.snapshot,
    policy: payload.policy ?? defaultWorkspaceAccessPolicy(workspaceId),
    credentialRefIds: payload.credentialRefIds ?? [],
    mcpCatalog: (payload.mcpCatalog ?? []).map((entry) => ({
      ...entry,
      createdAt:
        entry.createdAt instanceof Date ? entry.createdAt : new Date(String(entry.createdAt)),
    })),
    pinnedAt: payload.pinnedAt ? new Date(payload.pinnedAt) : new Date(),
  };
}

export function materializeBootstrapFromProfileSyncEntry(entry: ProfileSyncEntry): void {
  storeProfileBootstrapBundle(materializeProfileBootstrapBundleFromSync(entry));
}

export function handleProfilePinnedWebhook(
  payload: ProfilePinnedWebhookPayload,
): ProfileSyncEntry | null {
  const entry = normalizeProfileSyncEntry(payload);
  if (!entry) return null;
  cache.set(profileSyncCacheKey(entry.profileId, entry.versionId), entry);
  materializeBootstrapFromProfileSyncEntry(entry);
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
    const normalized: ProfileSyncEntry = {
      ...entry,
      pinnedAt: new Date(entry.pinnedAt),
      mcpCatalog: (entry.mcpCatalog ?? []).map((catalogEntry) => ({
        ...catalogEntry,
        createdAt:
          catalogEntry.createdAt instanceof Date
            ? catalogEntry.createdAt
            : new Date(String(catalogEntry.createdAt)),
      })),
    };
    cache.set(profileSyncCacheKey(normalized.profileId, normalized.versionId), normalized);
    materializeBootstrapFromProfileSyncEntry(normalized);
  }
  return body.profiles ?? [];
}

export function assertOfflineSessionAllowed(
  profileId: string,
  versionId: string,
  opts: { offline: boolean; enterpriseMode: boolean },
): void {
  if (!opts.enterpriseMode || !opts.offline) return;
  if (!getProfileBootstrapBundle(profileId, versionId)) {
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
