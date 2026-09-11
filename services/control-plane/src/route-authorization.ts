import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlPlaneStore } from "@diy-agent/db";
import type { ProfileId, TenantId, WorkspaceId } from "@diy-agent/domain";
import { authenticatePlatformAdmin, authenticateServiceAccount, type WorkspaceAction } from "@diy-agent/auth";
import { requireAuth, requireWorkspacePermission, requireServiceAccount, type AuthOptions, type ServiceAccountOptions } from "./auth-middleware.js";
import { readBody } from "./request-body.js";

/** A single admission boundary covers every route, including newly added routes. */
export async function authorizeRoute(req: IncomingMessage, res: ServerResponse, store: ControlPlaneStore,
  authOptions: AuthOptions, serviceOptions: ServiceAccountOptions, platformKey?: string): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const deny = (status: number, error: string) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
    return false;
  };
  if (path === "/health" || path === "/ready" || (method === "GET" && /^\/marketplace\/skills(?:\/[^/]+)?$/.test(path))) return true;
  if (path === "/sessions/resolve" && method === "POST") {
    const body = await readBody(req);
    const resolved = await store.resolveSession(String(body.sessionId ?? ""), req.headers.authorization?.replace(/^Bearer /, "") ?? "");
    return Boolean(resolved) || deny(401, "invalid_session_token");
  }
  const platformRoute = (path === "/tenants" || path === "/marketplace/skills") && method === "POST";
  if (platformRoute) {
    if (!platformKey) return authOptions.mode === "none" || deny(503, "platform_admin_not_configured");
    return authenticatePlatformAdmin(req.headers.authorization, platformKey) || deny(401, "unauthorized_platform_admin");
  }
  const serviceRoute = (method === "GET" && (/^\/profiles\/[^/]+\/versions\/[^/]+$/.test(path) || /^\/tenants\/[^/]+\/profile-sync$/.test(path) || path === "/mcp/catalog")) || (method === "POST" && ["/traces", "/usage/events"].includes(path));
  if (serviceRoute && serviceOptions.mode !== "none") {
    if (!requireServiceAccount(req, res, serviceOptions)) return false;
    const serviceTenant = Object.entries(serviceOptions.tenantTokens ?? {}).find(([,token]) => authenticateServiceAccount(req.headers.authorization,token))?.[0];
    if (!serviceTenant) return true; // Explicit legacy platform-wide service token; production startup disables it.
    const body = method === "POST" ? await readBody(req) : {};
    const ids = [body.tenantId,url.searchParams.get("tenantId"),path.match(/^\/tenants\/([^/]+)/)?.[1]].filter(Boolean);
    const profileId = path.match(/^\/profiles\/([^/]+)/)?.[1] ?? body.profileId;
    if (profileId) {
      const owner = await store.getTenantForProfile(profileId as ProfileId);
      if (!owner) return deny(404,"profile_not_found");
      ids.push(owner.id);
    }
    return (ids.length > 0 && ids.every(id => id === serviceTenant)) || deny(403,"service_tenant_mismatch");
  }
  if (authOptions.mode === "none") return true;
  if (path === "/api-keys" && platformKey && authenticatePlatformAdmin(req.headers.authorization, platformKey)) return true;
  const auth = await requireAuth(req, res, store, authOptions);
  if (!auth) return false;
  const body = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? await readBody(req) : {};
  const tenantIds = [body.tenantId, url.searchParams.get("tenantId"), path.match(/^\/tenants\/([^/]+)/)?.[1]].filter(Boolean);
  const workspaceIds = [path.match(/^\/workspaces\/([^/]+)/)?.[1], body.workspaceId, url.searchParams.get("workspaceId")].filter(Boolean);
  if (new Set(workspaceIds).size > 1) return deny(403, "workspace_mismatch");
  let workspaceId = workspaceIds[0] as WorkspaceId | undefined;
  let profileId = (path.match(/^\/profiles\/([^/]+)/)?.[1] ?? body.profileId) as ProfileId | undefined;
  const runId = path.match(/^\/evolution\/runs\/([^/]+)/)?.[1];
  if (runId && runId !== "trigger") {
    const run = await store.getEvolutionRun(runId);
    if (!run) return deny(404, "not_found");
    profileId = run.profileId;
  }
  if (profileId) {
    const profile = await store.getProfile(profileId);
    const tenant = await store.getTenantForProfile(profileId);
    if (!profile || !tenant) return deny(404, "profile_not_found");
    if (workspaceId && workspaceId !== profile.workspaceId) return deny(403, "workspace_mismatch");
    workspaceId = profile.workspaceId;
    tenantIds.push(tenant.id);
  }
  if (workspaceId) {
    const workspace = await store.getWorkspace(workspaceId);
    if (!workspace) return deny(404, "workspace_not_found");
    tenantIds.push(workspace.tenantId);
  }
  if (!tenantIds.length || tenantIds.some(id => id !== auth.tenantId)) return deny(403, "tenant_mismatch");
  if (auth.scopes.includes("tenant.admin")) return true;
  if (["/api-keys", "/workspaces", "/credentials/refs", "/webhooks", "/audit"].includes(path) ||
      path.startsWith("/api-keys/") || path.startsWith("/tool-approvals/") || path === "/sessions/recover" || path.startsWith("/tenants/") || path.startsWith("/mcp/") || path.startsWith("/marketplace/")) return deny(403, "tenant_admin_required");
  if (!workspaceId) return deny(403, "tenant_admin_required");
  const action: WorkspaceAction = path === "/orchestration/run" ? "orchestration.run"
    : path === "/sessions" || path === "/kb/search" ? "session.create"
    : path.includes("/policy") ? "policy.write" : path === "/workspace-members" ? "workspace.admin"
    : path.endsWith("/pin") ? "profile.pin" : path.includes("/approve") || path.includes("/reject")
      ? "evolution.approve" : "profile.create";
  return requireWorkspacePermission(store, res, auth, authOptions, workspaceId, action);
}
