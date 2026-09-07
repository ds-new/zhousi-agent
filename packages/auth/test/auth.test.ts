import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authenticateApiKey,
  authenticateBearer,
  canPerformWorkspaceAction,
  generateApiKey,
  hashApiKey,
  parseDevOidcToken,
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
    const ctx = await authenticateBearer("Bearer oidc.tenant-2.alice@corp.com", []);
    assert.ok(ctx);
    assert.equal(ctx!.tenantId, "tenant-2");
    assert.equal(ctx!.method, "oidc");
    assert.equal(parseDevOidcToken("oidc.tenant-2.alice@corp.com")?.sub, "alice@corp.com");
  });

  it("enforces workspace RBAC roles", () => {
    assert.equal(canPerformWorkspaceAction("admin", "evolution.approve"), true);
    assert.equal(canPerformWorkspaceAction("builder", "profile.create"), true);
    assert.equal(canPerformWorkspaceAction("builder", "evolution.approve"), false);
    assert.equal(canPerformWorkspaceAction("user", "session.create"), true);
    assert.equal(canPerformWorkspaceAction("user", "profile.create"), false);
  });
});
