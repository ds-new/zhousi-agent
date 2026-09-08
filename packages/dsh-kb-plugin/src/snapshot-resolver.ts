import type { KnowledgeBaseConfig, ProfileId, ProfileVersionId, WorkspaceId } from "@diy-agent/domain";
import {
  getProfileBootstrapBundle,
  readKbConfigFromSnapshot,
} from "@diy-agent/dsh-bootstrap-plugin/bundle";

export function getKbConfigFromBundle(
  profileId: string,
  profileVersionId: string,
): KnowledgeBaseConfig {
  const bundle = getProfileBootstrapBundle(profileId, profileVersionId);
  if (!bundle) throw new Error("kb_config_unavailable");
  if (bundle.kbConfig) return bundle.kbConfig;
  const snapshotConfig = readKbConfigFromSnapshot(bundle.snapshot);
  if (snapshotConfig) return snapshotConfig;
  throw new Error("kb_config_unavailable");
}

export function resolveKbConfigFromSnapshot(
  profileId: string,
  profileVersionId: string,
): KnowledgeBaseConfig {
  return getKbConfigFromBundle(profileId, profileVersionId);
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
  return getKbConfigFromBundle(input.profileId, input.profileVersionId);
}
