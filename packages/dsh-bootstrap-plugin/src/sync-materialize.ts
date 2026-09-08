import type {
  McpCatalogEntry,
  ProfileBootstrapBundle,
  ProfileSyncEntry,
} from "@diy-agent/domain";
import { buildProfileBootstrapBundle } from "./bundle.js";

export type ProfileSyncBootstrapPayload = Pick<
  ProfileSyncEntry,
  | "profileId"
  | "versionId"
  | "workspaceId"
  | "tenantId"
  | "snapshot"
  | "policy"
  | "credentialRefIds"
  | "mcpCatalog"
> & { pinnedAt?: Date | string };

function normalizeMcpCatalogEntry(entry: McpCatalogEntry): McpCatalogEntry {
  return {
    ...entry,
    createdAt:
      entry.createdAt instanceof Date ? entry.createdAt : new Date(String(entry.createdAt)),
  };
}

export function materializeProfileBootstrapBundleFromSync(
  payload: ProfileSyncBootstrapPayload,
): ProfileBootstrapBundle {
  return buildProfileBootstrapBundle({
    profileId: payload.profileId,
    profileVersionId: payload.versionId,
    workspaceId: payload.workspaceId,
    tenantId: payload.tenantId,
    snapshot: payload.snapshot,
    policy: payload.policy,
    credentialRefIds: payload.credentialRefIds,
    mcpCatalog: (payload.mcpCatalog ?? []).map(normalizeMcpCatalogEntry),
    pinnedAt: payload.pinnedAt
      ? payload.pinnedAt instanceof Date
        ? payload.pinnedAt
        : new Date(payload.pinnedAt)
      : undefined,
  });
}
