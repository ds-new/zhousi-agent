import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { PROFILE_SYNC_RECONCILE_INTERVAL_MS } from "@diy-agent/domain";
import {
  assertOfflineSessionAllowed,
  getCachedProfileSync,
  handleProfilePinnedWebhook,
  profileSyncCacheKey,
  reconcilePinnedProfiles,
  resetProfileSyncCacheForTests,
} from "../src/index.js";

describe("dsh-profile-sync-plugin", () => {
  beforeEach(() => {
    resetProfileSyncCacheForTests();
  });

  it("caches snapshot from profile.pinned webhook payload", () => {
    const entry = handleProfilePinnedWebhook({
      profileId: "profile-1",
      versionId: "version-1",
      snapshot: { name: "support-bot" },
    });
    assert.ok(entry);
    assert.equal(getCachedProfileSync("profile-1", "version-1")?.snapshot.name, "support-bot");
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
              snapshot: { name: "bot" },
              pinnedAt: new Date().toISOString(),
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    assert.equal(profiles.length, 1);
    assert.ok(getCachedProfileSync("p1", "v1"));
  });

  it("refuses offline enterprise sessions without cached snapshot", () => {
    assert.throws(
      () =>
        assertOfflineSessionAllowed("p1", "v1", { offline: true, enterpriseMode: true }),
      /profile_sync_cache_miss_offline/,
    );
    handleProfilePinnedWebhook({
      profileId: "p1",
      versionId: "v1",
      snapshot: { name: "bot" },
    });
    assert.doesNotThrow(() =>
      assertOfflineSessionAllowed("p1", "v1", { offline: true, enterpriseMode: true }),
    );
  });

  it("uses 5-minute reconcile interval constant", () => {
    assert.equal(PROFILE_SYNC_RECONCILE_INTERVAL_MS, 5 * 60 * 1000);
    assert.equal(profileSyncCacheKey("a", "b"), "a:b");
  });
});
