import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify } from "jose";
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
  const key = `${API_KEY_PREFIX}${tenantId}.${secret}`;
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
  allowDevOidc = false,
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

  const devClaims = allowDevOidc && !oidcVerifier ? parseDevOidcToken(token) : null;
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
  const expected = Buffer.from(expectedToken);
  const presented = Buffer.from(token);
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
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
  const expected = Buffer.from(expectedToken);
  const presented = Buffer.from(token);
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}

export interface JwksOidcConfig {
  issuer: string;
  audience: string | string[];
  /** Operator-configured HTTPS JWKS endpoint; JWT-supplied jku/x5u URLs are never used. */
  jwksUrl?: string;
  algorithms?: Array<"RS256" | "PS256" | "ES256" | "EdDSA">;
  /** Explicit development-only symmetric keys. Never combined with remote JWKS. */
  hs256Secrets?: Record<string, string>;
  allowDevHs256?: boolean;
  /** Dependency injection for integration tests or an operator-managed fetch implementation. */
  fetchImpl?: typeof fetch;
}

/** Standard JOSE verification; construct once to preserve key caching and rotation cooldown. */
export function createJwksOidcVerifier(config: JwksOidcConfig): OidcVerifier {
  if (!config.issuer || !config.audience || (Array.isArray(config.audience) && !config.audience.length)) throw new Error("oidc_issuer_and_audience_required");
  if (config.hs256Secrets && !config.allowDevHs256) throw new Error("oidc_dev_hs256_not_enabled");
  if (config.hs256Secrets && config.jwksUrl) throw new Error("oidc_key_sources_must_be_distinct");
  const algorithms = config.hs256Secrets ? ["HS256"] : config.algorithms ?? ["RS256", "PS256", "ES256", "EdDSA"];
  if (!config.hs256Secrets && (!algorithms.length || algorithms.some(alg => !["RS256", "PS256", "ES256", "EdDSA"].includes(alg)))) throw new Error("oidc_algorithm_not_allowed");
  let remote: ReturnType<typeof createRemoteJWKSet> | undefined;
  if (config.jwksUrl) {
    const url = new URL(config.jwksUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("oidc_jwks_https_required");
    remote = createRemoteJWKSet(url, { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
      ...(config.fetchImpl ? { [customFetch]: config.fetchImpl } : {}) });
  } else if (!config.hs256Secrets) throw new Error("oidc_jwks_url_required");
  return async (token: string): Promise<OidcClaims | null> => {
    if (!token || token.length > 16_384) return null;
    try {
      const options = { issuer: config.issuer, audience: config.audience, algorithms, requiredClaims: ["exp", "iat", "sub"] };
      let payload: import("jose").JWTPayload;
      if (remote) ({ payload } = await jwtVerify(token, remote, options));
      else {
        const header = decodeProtectedHeader(token);
        const secret = header.kid && Object.hasOwn(config.hs256Secrets!, header.kid) ? config.hs256Secrets![header.kid] : undefined;
        if (!secret) return null;
        ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), options));
      }
      const tenantId = payload.tenant_id ?? payload.tenantId;
      if (typeof tenantId !== "string" || !tenantId || tenantId.length > 256 || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 512) return null;
      if (typeof payload.iat !== "number" || payload.iat > Math.floor(Date.now() / 1000)) return null;
      return { tenantId: tenantId as TenantId, sub: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
    } catch { return null; }
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
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 3600, ...claims })).toString("base64url");
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
