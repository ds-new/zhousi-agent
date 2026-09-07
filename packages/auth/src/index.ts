import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { TenantId, WorkspaceRole } from "@diy-agent/domain";

export const API_KEY_PREFIX = "diy_sk_";
export const SERVICE_ACCOUNT_PREFIX = "diy_sa_";
export const PLATFORM_ADMIN_PREFIX = "diy_pa_";

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

export function authenticateServiceAccount(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  const token = parseBearerToken(authorization);
  if (!token || !token.startsWith(SERVICE_ACCOUNT_PREFIX)) return false;
  if (expectedToken.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(expectedToken), Buffer.from(token));
}

export function generateServiceAccountToken(): string {
  return `${SERVICE_ACCOUNT_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export function authenticatePlatformAdmin(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  const token = parseBearerToken(authorization);
  if (!token || !token.startsWith(PLATFORM_ADMIN_PREFIX)) return false;
  if (expectedToken.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(expectedToken), Buffer.from(token));
}

export interface JwksOidcConfig {
  issuer: string;
  audience?: string;
  /** HS256 secrets keyed by JWT `kid` for dev/test JWKS flows. */
  hs256Secrets?: Record<string, string>;
}

function verifyHs256Jwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const data = `${headerB64}.${payloadB64}`;
  const expected = createHmac("sha256", secret).update(data).digest("base64url");
  try {
    if (
      signatureB64!.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signatureB64!), Buffer.from(expected))
    ) {
      return null;
    }
  } catch {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

export function createJwksOidcVerifier(config: JwksOidcConfig): OidcVerifier {
  return async (token: string): Promise<OidcClaims | null> => {
    const headerPart = token.split(".")[0];
    if (!headerPart) return null;
    let header: { alg?: string; kid?: string };
    try {
      header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as {
        alg?: string;
        kid?: string;
      };
    } catch {
      return null;
    }
    if (header.alg !== "HS256" || !header.kid) return null;
    const secret = config.hs256Secrets?.[header.kid];
    if (!secret) return null;
    const payload = verifyHs256Jwt(token, secret);
    if (!payload) return null;
    if (payload.iss !== config.issuer) return null;
    if (config.audience && payload.aud !== config.audience) return null;
    const tenantId = (payload.tenant_id ?? payload.tenantId) as TenantId | undefined;
    const sub = payload.sub as string | undefined;
    if (!tenantId || !sub) return null;
    return { tenantId, sub, email: payload.email as string | undefined };
  };
}

export function signDevHs256Jwt(
  claims: Record<string, unknown>,
  secret: string,
  kid = "dev",
): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
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
