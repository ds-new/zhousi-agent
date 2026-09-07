/**
 * Control Plane → Data Plane KB proxy (Phase A transition).
 */
import type { AgentProfile, TenantId } from "@diy-agent/domain";
import type { KnowledgeBaseConfig } from "@diy-agent/domain";

export type DataPlaneFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface KbProxyOptions {
  dataPlaneUrl?: string;
  dataPlaneInternalToken?: string;
  fetchImpl?: DataPlaneFetch;
}

function resolveDataPlaneUrl(options: KbProxyOptions): string {
  const base = options.dataPlaneUrl ?? process.env.DIY_DATA_PLANE_URL ?? "http://127.0.0.1:3080";
  return base.replace(/\/$/, "");
}

function proxyHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const resolved = token ?? process.env.DIY_DATA_PLANE_INTERNAL_TOKEN;
  if (resolved) headers.Authorization = `Bearer ${resolved}`;
  return headers;
}

async function forwardJson(
  options: KbProxyOptions,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fetchImpl(`${resolveDataPlaneUrl(options)}${path}`, {
    method: "POST",
    headers: proxyHeaders(options.dataPlaneInternalToken),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

export async function proxyKbSearch(
  options: KbProxyOptions,
  profile: AgentProfile,
  tenantId: TenantId | undefined,
  query: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const kbConfig: KnowledgeBaseConfig = profile.kbConfig ?? { internal: { enabled: true } };
  return forwardJson(options, "/kb/search", {
    profileId: profile.id,
    workspaceId: profile.workspaceId,
    tenantId,
    query,
    kbConfig,
  });
}

export async function proxyKbDocumentIngest(
  options: KbProxyOptions,
  profile: AgentProfile,
  tenantId: TenantId | undefined,
  title: string,
  content: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const kbConfig: KnowledgeBaseConfig = profile.kbConfig ?? { internal: { enabled: true } };
  return forwardJson(options, "/kb/documents", {
    profileId: profile.id,
    workspaceId: profile.workspaceId,
    tenantId,
    title,
    content,
    kbConfig,
  });
}
