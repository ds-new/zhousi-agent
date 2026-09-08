import type {
  AccessPolicy,
  KnowledgeBaseConfig,
  McpCatalogEntry,
  ProfileBootstrapBundle,
  ProfileId,
  ProfileVersionId,
  TenantId,
  WorkspaceId,
} from "@diy-agent/domain";
import { defaultWorkspaceAccessPolicy } from "@diy-agent/domain";

const bundleCache = new Map<string, ProfileBootstrapBundle>();
const activeBundleByWorkspace = new Map<string, ProfileBootstrapBundle>();

export function bundleCacheKey(profileId: string, profileVersionId: string): string {
  return `${profileId}:${profileVersionId}`;
}

export function storeProfileBootstrapBundle(bundle: ProfileBootstrapBundle): void {
  bundleCache.set(bundleCacheKey(bundle.profileId, bundle.profileVersionId), bundle);
}

export function getProfileBootstrapBundle(
  profileId: string,
  profileVersionId: string,
): ProfileBootstrapBundle | null {
  return bundleCache.get(bundleCacheKey(profileId, profileVersionId)) ?? null;
}

export function getActiveBootstrapBundle(workspaceId: string): ProfileBootstrapBundle | null {
  return activeBundleByWorkspace.get(workspaceId) ?? null;
}

export function setActiveBootstrapBundle(bundle: ProfileBootstrapBundle): void {
  activeBundleByWorkspace.set(bundle.workspaceId, bundle);
}

export function resetBootstrapCacheForTests(): void {
  bundleCache.clear();
  activeBundleByWorkspace.clear();
}

export function deriveBlockedMcpServers(catalog: McpCatalogEntry[]): string[] {
  return catalog
    .filter((entry) => entry.approvalStatus !== "approved")
    .map((entry) => entry.serverName);
}

export function readKbConfigFromSnapshot(
  snapshot: Record<string, unknown>,
): KnowledgeBaseConfig | undefined {
  if (!snapshot.kbConfig || typeof snapshot.kbConfig !== "object") return undefined;
  return snapshot.kbConfig as KnowledgeBaseConfig;
}

export function buildProfileBootstrapBundle(input: {
  profileId: ProfileId;
  profileVersionId: ProfileVersionId;
  workspaceId: WorkspaceId;
  tenantId: TenantId;
  snapshot: Record<string, unknown>;
  policy?: AccessPolicy;
  credentialRefIds?: string[];
  mcpCatalog?: McpCatalogEntry[];
  pinnedAt?: Date;
}): ProfileBootstrapBundle {
  const policy =
    input.policy ?? defaultWorkspaceAccessPolicy(input.workspaceId as WorkspaceId);
  const mcpCatalog = input.mcpCatalog ?? [];
  return {
    profileId: input.profileId,
    profileVersionId: input.profileVersionId,
    workspaceId: input.workspaceId,
    tenantId: input.tenantId,
    snapshot: input.snapshot,
    policy,
    credentialRefIds: input.credentialRefIds ?? [],
    mcpCatalog,
    blockedMcpServers: deriveBlockedMcpServers(mcpCatalog),
    kbConfig: readKbConfigFromSnapshot(input.snapshot),
    pinnedAt: input.pinnedAt,
  };
}

export function assertMcpCatalogApproved(
  serverName: string,
  bundle: ProfileBootstrapBundle,
): void {
  if (bundle.blockedMcpServers.includes(serverName)) {
    throw new Error(`mcp_catalog_not_approved:${serverName}`);
  }
}
