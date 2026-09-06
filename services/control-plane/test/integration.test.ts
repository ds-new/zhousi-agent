import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createControlPlaneServer } from "../src/server.js";

describe("Control Plane HTTP integration", () => {
  const cp = createControlPlaneServer({ port: 0, storage: "memory" });

  before(async () => {
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
  });

  after(async () => {
    await cp.close();
  });

  async function post(path: string, body: unknown) {
    const res = await fetch(`${cp.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it("provisions Tenant → Workspace → Agent Profile", async () => {
    const tenant = await post("/tenants", { name: "acme" });
    assert.equal(tenant.status, 201);
    assert.ok(tenant.json.id);

    const ws = await post("/workspaces", {
      tenantId: tenant.json.id,
      name: "demo",
    });
    assert.equal(ws.status, 201);

    const profile = await post("/profiles", {
      tenantId: tenant.json.id,
      workspaceId: ws.json.id,
      name: "bot",
      governanceTier: "L1",
      modelRoute: { provider: "deepseek", model: "deepseek-chat" },
      kbConfig: { internal: { enabled: true } },
    });
    assert.equal(profile.status, 201);
    assert.equal(profile.json.profile.name, "bot");
  });

  it("rejects disallowed model provider via Tenant Gateway", async () => {
    const tenant = await post("/tenants", { name: "gw-test" });
    const ws = await post("/workspaces", { tenantId: tenant.json.id });
    const denied = await post("/profiles", {
      tenantId: tenant.json.id,
      workspaceId: ws.json.id,
      modelRoute: { provider: "blocked-vendor", model: "x" },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, "model_provider_not_allowed");
  });

  it("creates Session with DSH meta keys", async () => {
    const tenant = await post("/tenants", { name: "sess" });
    const ws = await post("/workspaces", { tenantId: tenant.json.id });
    const profile = await post("/profiles", {
      tenantId: tenant.json.id,
      workspaceId: ws.json.id,
      modelRoute: { provider: "deepseek", model: "deepseek-chat" },
    });
    const session = await post("/sessions", {
      tenantId: tenant.json.id,
      profileId: profile.json.profile.id,
    });
    assert.equal(session.status, 201);
    assert.ok(session.json.dshMeta["diy.tenantId"]);
    assert.ok(session.json.dshMeta["diy.workspaceId"]);
    assert.ok(session.json.dshMeta["diy.profileId"]);
    assert.ok(session.json.dshMeta["diy.profileVersionId"]);
  });

  it("ingests and searches Knowledge Base documents", async () => {
    const tenant = await post("/tenants", { name: "kb" });
    const ws = await post("/workspaces", { tenantId: tenant.json.id });
    const profile = await post("/profiles", {
      tenantId: tenant.json.id,
      workspaceId: ws.json.id,
      kbConfig: { internal: { enabled: true } },
      modelRoute: { provider: "openai", model: "gpt-4o-mini" },
    });
    const pid = profile.json.profile.id;

    const doc = await post("/kb/documents", {
      profileId: pid,
      title: "FAQ",
      content: "退货政策：7天内可退",
    });
    assert.equal(doc.status, 201);

    const search = await post("/kb/search", {
      profileId: pid,
      query: "退货",
    });
    assert.equal(search.status, 200);
    assert.ok(search.json.hits.length >= 1);
    assert.equal(search.json.hits[0].source, "internal");
  });

  it("runs supervisor orchestration with handoffs", async () => {
    const tenant = await post("/tenants", { name: "orch" });
    const ws = await post("/workspaces", { tenantId: tenant.json.id });
    const profile = await post("/profiles", {
      tenantId: tenant.json.id,
      workspaceId: ws.json.id,
      orchestration: { topology: "supervisor" },
      modelRoute: { provider: "openai", model: "gpt-4o-mini" },
    });
    const run = await post("/orchestration/run", {
      profileId: profile.json.profile.id,
      goal: "分析投诉",
    });
    assert.equal(run.status, 200);
    assert.equal(run.json.plan.topology, "supervisor");
    assert.ok(run.json.handoffs.length >= 1);
  });

  it("triggers Evolution Run on low passRate for L1 Profile", async () => {
    const tenant = await post("/tenants", { name: "evo" });
    const ws = await post("/workspaces", { tenantId: tenant.json.id });
    const profile = await post("/profiles", {
      tenantId: tenant.json.id,
      workspaceId: ws.json.id,
      governanceTier: "L1",
      modelRoute: { provider: "deepseek", model: "deepseek-chat" },
    });
    const triggered = await post("/evolution/runs/trigger", {
      profileId: profile.json.profile.id,
      tenantId: tenant.json.id,
      passRate: 0.5,
    });
    assert.equal(triggered.status, 201);
    assert.equal(triggered.json.signal, true);
    assert.equal(triggered.json.run.trigger, "signal");
  });

  it("skips signal Evolution when passRate is above threshold", async () => {
    const tenant = await post("/tenants", { name: "evo-skip" });
    const ws = await post("/workspaces", { tenantId: tenant.json.id });
    const profile = await post("/profiles", {
      tenantId: tenant.json.id,
      workspaceId: ws.json.id,
      governanceTier: "L1",
      modelRoute: { provider: "deepseek", model: "deepseek-chat" },
    });
    const skipped = await post("/evolution/runs/trigger", {
      profileId: profile.json.profile.id,
      tenantId: tenant.json.id,
      passRate: 0.9,
    });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.json.skipped, true);
  });
});
