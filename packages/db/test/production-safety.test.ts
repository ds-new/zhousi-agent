import assert from "node:assert/strict";
import { it } from "node:test";
import { MemoryStore } from "../src/memory-store.js";

it("API key revocation is limited to its tenant and takes effect immediately", async () => {
  const store = new MemoryStore();
  const a = await store.createTenant({ name: "key owner" });
  const b = await store.createTenant({ name: "other tenant" });
  const key = await store.createApiKey(a.id, "revocable");
  assert.equal(await store.revokeApiKey(b.id, key.record.id), false);
  assert.equal((await store.listApiKeys(a.id)).length, 1);
  assert.equal(await store.revokeApiKey(a.id, key.record.id), true);
  assert.equal((await store.listApiKeys(a.id)).length, 0);
  assert.equal(await store.revokeApiKey(a.id, key.record.id), false);
});

it("usage events charge once and reject conflicting replays and invalid amounts", async () => {
  const store = new MemoryStore();
  const tenant = await store.createTenant({ name: "metering" });
  assert.equal((await store.recordUsageOnce(tenant.id, "turn-1", 12)).duplicate, false);
  const replay = await store.recordUsageOnce(tenant.id, "turn-1", 12);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.quota.tokensUsedToday, 12);
  await assert.rejects(store.recordUsageOnce(tenant.id, "turn-1", 13), /usage_event_conflict/);
  for (const tokens of [-1, NaN, Infinity, 1.5]) await assert.rejects(store.recordUsageOnce(tenant.id, "bad", tokens), /invalid_token_usage/);
});

it("metering does not consume request rate allowance and repeated quota answers retain their reason", async () => {
  const store = new MemoryStore();
  const tenant = await store.createTenant({ name: "separate metering", gateway: { rateLimitRpm: 1, maxTokensPerDay: 10 } });
  await store.recordUsageOnce(tenant.id, "turn-1", 2);
  assert.equal((await store.checkSessionQuota(tenant.id)).allowed, true);
  assert.equal((await store.recordUsageOnce(tenant.id, "turn-2", 8)).quota.reason, "daily_token_quota_exceeded");
  assert.equal((await store.recordUsageOnce(tenant.id, "turn-2", 8)).quota.reason, "daily_token_quota_exceeded");
});

it("leases skip concurrent owners, permit store operations and release after failure", async () => {
  const store = new MemoryStore();
  let release!: () => void;
  const pending = store.withLease("profile:x", async () => {
    await store.createTenant({ name: "inside lease" });
    await new Promise<void>(resolve => { release = resolve; });
    return "done";
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await store.withLease("profile:x", async () => "wrong"), null);
  release();
  assert.equal(await pending, "done");
  await assert.rejects(store.withLease("profile:x", async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await store.withLease("profile:x", async () => "recovered"), "recovered");
});
