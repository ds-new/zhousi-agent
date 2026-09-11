import assert from "node:assert/strict";
import { it } from "node:test";
import { MemoryStore } from "@diy-agent/db";
import { dispatchWebhooks } from "../src/webhook-dispatcher.js";

async function setup(urls: string[]) {
  const store = new MemoryStore();
  const tenant = await store.createTenant({ name: "webhook policies" });
  for (const url of urls) await store.registerWebhook({ tenantId: tenant.id, url, events: ["updated"] });
  return { store, tenant };
}

it("webhooks reject origins outside the allowlist, credentials and non-HTTP protocols", async () => {
  const { store, tenant } = await setup(["https://allowed.test/hook", "https://allowed.test.evil/hook", "https://user:password@allowed.test/hook", "file:///tmp/hook", "not-a-url"]);
  const calls: string[] = [];
  const results = await dispatchWebhooks(store, tenant.id, "updated", {}, async url => {
    calls.push(url); return new Response(null, { status: 204 });
  }, { allowedOrigins: ["https://allowed.test"] });
  assert.deepEqual(calls, ["https://allowed.test/hook"]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => !result.ok).length, 4);
  const denied = await dispatchWebhooks(store, tenant.id, "updated", {}, async () => { throw new Error("must not fetch"); }, { allowedOrigins: [] });
  assert.equal(denied.length, 5);
  assert.ok(denied.every(result => !result.ok));
});

it("webhooks pass a deadline and forbid redirects, then cancel the response body", async () => {
  const { store, tenant } = await setup(["https://allowed.test/hook"]);
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const results = await dispatchWebhooks(store, tenant.id, "updated", {}, async (_url, init) => {
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    signal = init!.signal!;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
  }, { allowedOrigins: ["https://allowed.test"], timeoutMs: 10 });
  assert.equal(results[0]?.ok, true);
  assert.equal(cancelled, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signal?.aborted, true);
});

it("webhook delivery has a hard cap and reports skipped hooks as failures", async () => {
  const { store, tenant } = await setup(Array.from({ length: 40 }, (_, i) => `https://allowed.test/${i}`));
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(null, { status: 204 }); };
  const results = await dispatchWebhooks(store, tenant.id, "updated", {}, fetcher, { allowedOrigins: ["https://allowed.test"], maxDeliveries: 100 });
  assert.equal(calls, 32); assert.equal(results.length, 40);
  assert.equal(results.filter(result => !result.ok).length, 8);
  calls = 0;
  const smaller = await dispatchWebhooks(store, tenant.id, "updated", {}, fetcher, { maxDeliveries: 2 });
  assert.equal(calls, 2); assert.equal(smaller.filter(result => !result.ok).length, 38);
});
