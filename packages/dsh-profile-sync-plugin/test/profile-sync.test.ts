import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { PROFILE_SYNC_RECONCILE_INTERVAL_MS, defaultWorkspaceAccessPolicy } from "@diy-agent/domain";
import {
  getProfileBootstrapBundle,
  resetBootstrapCacheForTests,
} from "@diy-agent/dsh-bootstrap-plugin/bundle";
import {
  assertOfflineSessionAllowed,
  getCachedProfileSync,
  handleProfilePinnedWebhook,
  profileSyncCacheKey,
  reconcilePinnedProfiles,
  resetProfileSyncCacheForTests,
} from "../src/index.js";

function webhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    profileId: "profile-1",
    versionId: "version-1",
    workspaceId: "ws-1",
    tenantId: "tenant-1",
    snapshot: { name: "support-bot" },
    policy: defaultWorkspaceAccessPolicy("ws-1" as import("@diy-agent/domain").WorkspaceId),
    credentialRefIds: [],
    mcpCatalog: [],
    ...overrides,
  };
}

describe("dsh-profile-sync-plugin", () => {
  beforeEach(() => {
    resetProfileSyncCacheForTests();
    resetBootstrapCacheForTests();
  });

  it("caches snapshot from profile.pinned webhook payload", () => {
    const entry = handleProfilePinnedWebhook(webhookPayload());
    assert.ok(entry);
    assert.equal(getCachedProfileSync("profile-1", "version-1")?.snapshot.name, "support-bot");
  });

  it("materializes ProfileBootstrapBundle from webhook payload", () => {
    handleProfilePinnedWebhook(
      webhookPayload({
        credentialRefIds: ["vault://tenant/t1/mcp/github"],
        mcpCatalog: [
          {
            serverName: "github",
            tenantId: "tenant-1",
            transport: "stdio",
            defaultSensitivity: "normal",
            approvalStatus: "pending",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const bundle = getProfileBootstrapBundle("profile-1", "version-1");
    assert.ok(bundle);
    assert.deepEqual(bundle!.credentialRefIds, ["vault://tenant/t1/mcp/github"]);
    assert.deepEqual(bundle!.blockedMcpServers, ["github"]);
  });

  it("reconciles pinned profiles from Control Plane", async () => {
    const profiles = await reconcilePinnedProfiles("http://cp.local", "tenant-1", async (url) => {
      assert.match(url, /\/tenants\/tenant-1\/profile-sync$/);
      return new Response(
        JSON.stringify({
          profiles: [
            {
              profileId: "p1",
              versionId: "v1",
              workspaceId: "ws-1",
              tenantId: "tenant-1",
              snapshot: { name: "bot" },
              policy: defaultWorkspaceAccessPolicy("ws-1" as import("@diy-agent/domain").WorkspaceId),
              credentialRefIds: [],
              mcpCatalog: [],
              pinnedAt: new Date().toISOString(),
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    assert.equal(profiles.length, 1);
    assert.ok(getCachedProfileSync("p1", "v1"));
    assert.ok(getProfileBootstrapBundle("p1", "v1"));
  });

  it("refuses offline enterprise sessions without cached bootstrap bundle", () => {
    assert.throws(
      () =>
        assertOfflineSessionAllowed("p1", "v1", { offline: true, enterpriseMode: true }),
      /profile_sync_cache_miss_offline/,
    );
    handleProfilePinnedWebhook(
      webhookPayload({
        profileId: "p1",
        versionId: "v1",
      }),
    );
    assert.doesNotThrow(() =>
      assertOfflineSessionAllowed("p1", "v1", { offline: true, enterpriseMode: true }),
    );
  });

  it("uses 5-minute reconcile interval constant", () => {
    assert.equal(PROFILE_SYNC_RECONCILE_INTERVAL_MS, 5 * 60 * 1000);
    assert.equal(profileSyncCacheKey("a", "b"), "a:b");
  });
});
