import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authenticateBearer,
  authenticatePlatformAdmin,
  authenticateServiceAccount,
  canPerformWorkspaceAction,
  createJwksOidcVerifier,
  type AuthContext,
  type JwksOidcConfig,
  type OidcVerifier,
  type WorkspaceAction,
} from "@diy-agent/auth";
import type { ControlPlaneStore } from "@diy-agent/db";
import type { TenantId, WorkspaceId } from "@diy-agent/domain";

export type AuthMode = "none" | "api_key";
export type ServiceAccountMode = "none" | "token";

export interface AuthOptions {
  mode: AuthMode;
  oidcVerifier?: OidcVerifier;
  jwksOidc?: JwksOidcConfig;
}

export interface ServiceAccountOptions {
  mode: ServiceAccountMode;
  token?: string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function resolveOidcVerifier(options: AuthOptions): OidcVerifier | undefined {
  if (options.oidcVerifier) return options.oidcVerifier;
  if (options.jwksOidc) return createJwksOidcVerifier(options.jwksOidc);
  return undefined;
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
  return authenticateBearer(
    req.headers.authorization,
    allKeys,
    resolveOidcVerifier(options),
  );
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

export function requirePlatformAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  platformAdminKey?: string,
): boolean {
  if (!platformAdminKey) return true;
  if (!authenticatePlatformAdmin(req.headers.authorization, platformAdminKey)) {
    json(res, 401, { error: "unauthorized_platform_admin" });
    return false;
  }
  return true;
}

export function requireServiceAccount(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServiceAccountOptions,
): boolean {
  if (options.mode === "none") return true;
  if (!options.token) {
    json(res, 500, { error: "service_account_not_configured" });
    return false;
  }
  if (!authenticateServiceAccount(req.headers.authorization, options.token)) {
    json(res, 401, { error: "unauthorized_service_account" });
    return false;
  }
  return true;
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
