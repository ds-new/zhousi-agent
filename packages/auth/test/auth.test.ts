import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authenticateApiKey,
  authenticateBearer,
  authenticateServiceAccount,
  authenticatePlatformAdmin,
  canPerformWorkspaceAction,
  createJwksOidcVerifier,
  generateApiKey,
  generateServiceAccountToken,
  hashApiKey,
  parseDevOidcToken,
  signDevHs256Jwt,
} from "../src/index.js";

describe("@diy-agent/auth", () => {
  it("generates and verifies diy_sk_* API keys", () => {
    const tenantId = "tenant-1" as import("@diy-agent/domain").TenantId;
    const { key, record } = generateApiKey(tenantId, "ci-key");
    assert.match(key, /^diy_sk_/);
    assert.equal(record.hash, hashApiKey(key));
    const ctx = authenticateApiKey(key, [record]);
    assert.ok(ctx);
    assert.equal(ctx!.tenantId, tenantId);
    assert.equal(ctx!.method, "api_key");
  });

  it("authenticates dev OIDC token format", async () => {
    const ctx = await authenticateBearer("Bearer oidc.tenant-2.alice@corp.com", [], undefined, true);
    assert.ok(ctx);
    assert.equal(ctx!.tenantId, "tenant-2");
    assert.equal(ctx!.method, "oidc");
    assert.equal(parseDevOidcToken("oidc.tenant-2.alice@corp.com")?.sub, "alice@corp.com");
  });

  it("rejects unsigned dev tokens by default and after a real verifier rejects them", async () => {
    assert.equal(await authenticateBearer("Bearer oidc.tenant-2.admin", []), null);
    assert.equal(await authenticateBearer("Bearer oidc.tenant-2.admin", [], async () => null, true), null);
  });

  it("enforces workspace RBAC roles", () => {
    assert.equal(canPerformWorkspaceAction("admin", "evolution.approve"), true);
    assert.equal(canPerformWorkspaceAction("builder", "profile.create"), true);
    assert.equal(canPerformWorkspaceAction("builder", "evolution.approve"), false);
    assert.equal(canPerformWorkspaceAction("user", "session.create"), true);
    assert.equal(canPerformWorkspaceAction("user", "profile.create"), false);
  });

  it("authenticates Data Plane service account tokens", () => {
    const token = generateServiceAccountToken();
    assert.ok(authenticateServiceAccount(`Bearer ${token}`, token));
    assert.equal(authenticateServiceAccount("Bearer diy_sa_wrong", token), false);
  });

  it("rejects non-ASCII token bytes without raising a timing comparison error", () => {
    assert.equal(authenticateServiceAccount("Bearer diy_sa_é", "diy_sa_a"), false);
    assert.equal(authenticatePlatformAdmin("Bearer diy_pa_é", "diy_pa_a"), false);
  });

  it("verifies explicitly enabled development HS256 OIDC tokens", async () => {
    const secret = "phase3-test-secret";
    const tenantId = "tenant-jwks" as import("@diy-agent/domain").TenantId;
    const jwt = signDevHs256Jwt(
      { iss: "https://idp.example.com", aud: "diy-agent", sub: "alice@corp.com", tenant_id: tenantId },
      secret,
    );
    const verifier = createJwksOidcVerifier({
      issuer: "https://idp.example.com",
      audience: "diy-agent",
      allowDevHs256: true,
      hs256Secrets: { dev: secret },
    });
    const ctx = await authenticateBearer(`Bearer ${jwt}`, [], verifier);
    assert.ok(ctx);
    assert.equal(ctx!.tenantId, tenantId);
    assert.equal(ctx!.method, "oidc");
  });

  it("rejects expired, not-yet-valid and malformed NumericDate claims", async () => {
    const secret = "local-auth-regression-secret";
    const verifier = createJwksOidcVerifier({ issuer: "test", audience: "diy", allowDevHs256: true, hs256Secrets: { dev: secret } });
    for (const invalid of [{ exp: 1 }, { nbf: Math.floor(Date.now() / 1000) + 3600 }, { exp: "tomorrow" }, { nbf: "later" }]) {
      const token = signDevHs256Jwt({ iss: "test", aud: "diy", sub: "user", tenantId: "tenant", ...invalid }, secret);
      assert.equal(await verifier(token), null);
    }
  });

  it("requires explicit development authorization for configured HS256 secrets", () => {
    assert.throws(() => createJwksOidcVerifier({ issuer: "test", audience: "diy", hs256Secrets: { dev: "secret" } }), /oidc_dev_hs256_not_enabled/);
  });
});
