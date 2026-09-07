import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authenticateBearer,
  canPerformWorkspaceAction,
  type AuthContext,
  type OidcVerifier,
  type WorkspaceAction,
} from "@diy-agent/auth";
import type { ControlPlaneStore } from "@diy-agent/db";
import type { TenantId, WorkspaceId } from "@diy-agent/domain";

export type AuthMode = "none" | "api_key";

export interface AuthOptions {
  mode: AuthMode;
  oidcVerifier?: OidcVerifier;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function resolveAuthContext(
  req: IncomingMessage,
  store: ControlPlaneStore,
  options: AuthOptions,
): Promise<AuthContext | null> {
  if (options.mode === "none") {
    return {
      tenantId: "" as TenantId,
      subject: "anonymous",
      method: "api_key",
      scopes: ["tenant.admin"],
    };
  }

  const allKeys = await store.listAllApiKeys();
  return authenticateBearer(req.headers.authorization, allKeys, options.oidcVerifier);
}

export async function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
  options: AuthOptions,
  tenantId?: TenantId,
): Promise<AuthContext | null> {
  const auth = await resolveAuthContext(req, store, options);
  if (options.mode !== "none" && !auth) {
    json(res, 401, { error: "unauthorized" });
    return null;
  }
  if (tenantId && options.mode !== "none" && auth && auth.tenantId !== tenantId) {
    json(res, 403, { error: "tenant_mismatch" });
    return null;
  }
  return auth;
}

export async function requireWorkspacePermission(
  store: ControlPlaneStore,
  res: ServerResponse,
  auth: AuthContext | null,
  options: AuthOptions,
  workspaceId: WorkspaceId,
  action: WorkspaceAction,
): Promise<boolean> {
  if (options.mode === "none" || !auth) return true;
  if (auth.scopes.includes("tenant.admin")) return true;
  const member = await store.getWorkspaceMember(workspaceId, auth.subject);
  if (!member || !canPerformWorkspaceAction(member.role, action)) {
    json(res, 403, { error: "forbidden", action });
    return false;
  }
  return true;
}
