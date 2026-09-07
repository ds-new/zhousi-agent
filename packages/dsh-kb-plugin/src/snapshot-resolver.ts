import type { KnowledgeBaseConfig, ProfileId, ProfileVersionId } from "@diy-agent/domain";
import { getCachedProfileSync } from "@diy-agent/dsh-profile-sync-plugin";
import { getCachedProfileSnapshot } from "@diy-agent/dsh-tenant-plugin";

export function resolveKbConfigFromSnapshot(
  profileId: string,
  profileVersionId: string,
): KnowledgeBaseConfig {
  const syncEntry = getCachedProfileSync(profileId, profileVersionId);
  const syncConfig = readKbConfig(syncEntry?.snapshot);
  if (syncConfig) return syncConfig;

  const tenantEntry = getCachedProfileSnapshot(profileId, profileVersionId);
  const tenantConfig = readKbConfig(tenantEntry?.snapshot);
  if (tenantConfig) return tenantConfig;

  throw new Error("kb_config_unavailable");
}

function readKbConfig(snapshot: Record<string, unknown> | undefined): KnowledgeBaseConfig | null {
  if (!snapshot?.kbConfig || typeof snapshot.kbConfig !== "object") return null;
  return snapshot.kbConfig as KnowledgeBaseConfig;
}

export function resolveKbConfigForSession(input: {
  profileId: ProfileId;
  profileVersionId: ProfileVersionId;
  kbConfig?: KnowledgeBaseConfig;
}): KnowledgeBaseConfig {
  if (input.kbConfig) return input.kbConfig;
  return resolveKbConfigFromSnapshot(input.profileId, input.profileVersionId);
}
