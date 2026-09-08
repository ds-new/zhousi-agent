import type {
  AccessPolicy,
  McpCatalogEntry,
  ProfileBootstrapBundle,
  ProfileId,
  ProfileVersionId,
  TenantId,
  WorkspaceId,
} from "@diy-agent/domain";
import { defaultWorkspaceAccessPolicy } from "@diy-agent/domain";
import { buildProfileBootstrapBundle, getProfileBootstrapBundle } from "./bundle.js";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface MaterializeBootstrapInput {
  controlPlaneUrl: string;
  serviceAccountToken?: string;
  profileId: ProfileId;
  profileVersionId: ProfileVersionId;
  workspaceId: WorkspaceId;
  tenantId: TenantId;
  fetchImpl?: FetchLike;
  offline?: boolean;
}

function authHeaders(token: string | undefined): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function fetchProfileVersion(
  input: MaterializeBootstrapInput,
): Promise<{
  snapshot: Record<string, unknown>;
  policy?: AccessPolicy;
  credentialRefIds: string[];
}> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = input.controlPlaneUrl.replace(/\/$/, "");
  const res = await fetchImpl(
    `${base}/profiles/${input.profileId}/versions/${input.profileVersionId}`,
    { headers: authHeaders(input.serviceAccountToken ?? process.env.DIY_SERVICE_ACCOUNT_TOKEN) },
  );
  if (!res.ok) {
    throw new Error(`bootstrap_unavailable:profile_http_${res.status}`);
  }
  const body = (await res.json()) as {
    snapshot?: Record<string, unknown>;
    policy?: AccessPolicy;
    credentialRefIds?: string[];
  };
  if (!body.snapshot) throw new Error("bootstrap_unavailable:missing_snapshot");
  return {
    snapshot: body.snapshot,
    policy: body.policy,
    credentialRefIds: body.credentialRefIds ?? [],
  };
}

async function fetchMcpCatalog(
  input: MaterializeBootstrapInput,
): Promise<McpCatalogEntry[]> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = input.controlPlaneUrl.replace(/\/$/, "");
  const url = `${base}/mcp/catalog?tenantId=${encodeURIComponent(input.tenantId)}`;
  const res = await fetchImpl(url, {
    headers: authHeaders(input.serviceAccountToken ?? process.env.DIY_SERVICE_ACCOUNT_TOKEN),
  });
  if (!res.ok) {
    throw new Error(`bootstrap_unavailable:mcp_catalog_http_${res.status}`);
  }
  const body = (await res.json()) as { catalog?: McpCatalogEntry[] };
  return (body.catalog ?? []).map((entry) => ({
    ...entry,
    createdAt: entry.createdAt ? new Date(entry.createdAt) : new Date(),
  }));
}

export function isDevDegradeEnabled(): boolean {
  return process.env.DIY_BOOTSTRAP_DEV_DEGRADE === "true";
}

export async function materializeProfileBootstrapBundle(
  input: MaterializeBootstrapInput,
): Promise<ProfileBootstrapBundle> {
  const cached = getProfileBootstrapBundle(input.profileId, input.profileVersionId);
  if (input.offline) {
    if (!cached) throw new Error("bootstrap_unavailable:offline_cache_miss");
    return cached;
  }

  try {
    const version = await fetchProfileVersion(input);
    const mcpCatalog = await fetchMcpCatalog(input);
    return buildProfileBootstrapBundle({
      profileId: input.profileId,
      profileVersionId: input.profileVersionId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      snapshot: version.snapshot,
      policy: version.policy,
      credentialRefIds: version.credentialRefIds,
      mcpCatalog,
    });
  } catch (err) {
    if (cached) return cached;
    if (isDevDegradeEnabled()) {
      return buildProfileBootstrapBundle({
        profileId: input.profileId,
        profileVersionId: input.profileVersionId,
        workspaceId: input.workspaceId,
        tenantId: input.tenantId,
        snapshot: {},
        policy: defaultWorkspaceAccessPolicy(input.workspaceId),
        credentialRefIds: [],
        mcpCatalog: [],
      });
    }
    throw err;
  }
}
