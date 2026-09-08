import type { KnowledgeBaseConfig, ProfileId, ProfileVersionId, WorkspaceId } from "@diy-agent/domain";
import { getProfileBootstrapBundle } from "@diy-agent/dsh-bootstrap-plugin/bundle";
import { getCachedProfileSync } from "@diy-agent/dsh-profile-sync-plugin";

export function resolveKbConfigFromSnapshot(
  profileId: string,
  profileVersionId: string,
): KnowledgeBaseConfig {
  const syncEntry = getCachedProfileSync(profileId, profileVersionId);
  const syncConfig = readKbConfig(syncEntry?.snapshot);
  if (syncConfig) return syncConfig;

  const bundle = getProfileBootstrapBundle(profileId, profileVersionId);
  if (bundle?.kbConfig) return bundle.kbConfig;
  const bundleSnapshotConfig = readKbConfig(bundle?.snapshot);
  if (bundleSnapshotConfig) return bundleSnapshotConfig;

  throw new Error("kb_config_unavailable");
}

function readKbConfig(snapshot: Record<string, unknown> | undefined): KnowledgeBaseConfig | null {
  if (!snapshot?.kbConfig || typeof snapshot.kbConfig !== "object") return null;
  return snapshot.kbConfig as KnowledgeBaseConfig;
}

export interface KbSessionContext {
  workspaceId: WorkspaceId;
  profileId: ProfileId;
  profileVersionId: ProfileVersionId;
  tenantId?: string;
  kbConfig?: KnowledgeBaseConfig;
}

export function resolveKbConfigForSession(input: KbSessionContext): KnowledgeBaseConfig {
  if (input.kbConfig) return input.kbConfig;
  return resolveKbConfigFromSnapshot(input.profileId, input.profileVersionId);
}
