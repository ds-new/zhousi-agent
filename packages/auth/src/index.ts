import { createHash, randomBytes } from "node:crypto";
import type { TenantId, WorkspaceRole } from "@diy-agent/domain";

export const API_KEY_PREFIX = "diy_sk_";

export interface ApiKeyRecord {
  id: string;
  tenantId: TenantId;
  prefix: string;
  hash: string;
  name: string;
  createdAt: Date;
}

export interface GeneratedApiKey {
  key: string;
  record: ApiKeyRecord;
}

export interface AuthContext {
  tenantId: TenantId;
  subject: string;
  method: "api_key" | "oidc";
  scopes: string[];
}

export interface OidcClaims {
  sub: string;
  tenantId: TenantId;
  email?: string;
}

export type OidcVerifier = (token: string) => Promise<OidcClaims | null>;

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey(tenantId: TenantId, name: string): GeneratedApiKey {
  const secret = randomBytes(24).toString("base64url");
  const key = `${API_KEY_PREFIX}${secret}`;
  const record: ApiKeyRecord = {
    id: crypto.randomUUID(),
    tenantId,
    prefix: key.slice(0, 12),
    hash: hashApiKey(key),
    name,
    createdAt: new Date(),
  };
  return { key, record };
}

export function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim();
}

export function authenticateApiKey(
  token: string,
  keys: ApiKeyRecord[],
): AuthContext | null {
  if (!token.startsWith(API_KEY_PREFIX)) return null;
  const hash = hashApiKey(token);
  const match = keys.find((k) => k.hash === hash);
  if (!match) return null;
  return {
    tenantId: match.tenantId,
    subject: `api_key:${match.id}`,
    method: "api_key",
    scopes: ["tenant.admin"],
  };
}

/** Test/dev OIDC token format: `oidc.<tenantId>.<subject>` */
export function parseDevOidcToken(token: string): OidcClaims | null {
  if (!token.startsWith("oidc.")) return null;
  const parts = token.split(".");
  if (parts.length < 3) return null;
  return { tenantId: parts[1]! as TenantId, sub: parts.slice(2).join(".") };
}

export async function authenticateBearer(
  authorization: string | undefined,
  keys: ApiKeyRecord[],
  oidcVerifier?: OidcVerifier,
): Promise<AuthContext | null> {
  const token = parseBearerToken(authorization);
  if (!token) return null;

  const api = authenticateApiKey(token, keys);
  if (api) return api;

  if (oidcVerifier) {
    const claims = await oidcVerifier(token);
    if (claims) {
      return {
        tenantId: claims.tenantId,
        subject: claims.sub,
        method: "oidc",
        scopes: [],
      };
    }
  }

  const devClaims = parseDevOidcToken(token);
  if (devClaims) {
    return {
      tenantId: devClaims.tenantId,
      subject: devClaims.sub,
      method: "oidc",
      scopes: [],
    };
  }

  return null;
}

export type WorkspaceAction =
  | "workspace.admin"
  | "profile.create"
  | "profile.pin"
  | "golden_task.write"
  | "policy.write"
  | "evolution.approve"
  | "session.create"
  | "orchestration.run";

const ROLE_PERMISSIONS: Record<WorkspaceRole, WorkspaceAction[] | "*"> = {
  admin: "*",
  builder: [
    "profile.create",
    "golden_task.write",
    "orchestration.run",
    "session.create",
  ],
  user: ["session.create"],
};

export function canPerformWorkspaceAction(
  role: WorkspaceRole,
  action: WorkspaceAction,
): boolean {
  const perms = ROLE_PERMISSIONS[role];
  if (perms === "*") return true;
  return perms.includes(action);
}

export interface WorkspaceMemberRecord {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: Date;
}
