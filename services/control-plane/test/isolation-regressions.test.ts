import assert from "node:assert/strict";
import { it } from "node:test";
import { once } from "node:events";
import { MemoryStore } from "@diy-agent/db";
import { createControlPlaneServer } from "../src/server.js";

it("does not let a workspace builder gain tenant admin by supplying workspaceId to API key creation", async () => {
  const store = new MemoryStore();
  const tenant = await store.createTenant({ name: "Builder scope" });
  const workspace = (await store.createWorkspace({ tenantId: tenant.id }))!;
  await store.addWorkspaceMember(workspace.id, "builder@corp.com", "builder");
  const cp = createControlPlaneServer({ store, authMode: "api_key", allowDevOidc: true, port: 0 });
  await once(cp.server, "listening");
  try {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer oidc.${tenant.id}.builder@corp.com` };
    const allowed = await fetch(`${cp.baseUrl}/profiles`, {
      method: "POST", headers, body: JSON.stringify({ tenantId: tenant.id, workspaceId: workspace.id, name: "Allowed builder profile" }),
    });
    assert.equal(allowed.status, 201, "the builder identity must be valid for normal workspace operations");

    const escalation = await fetch(`${cp.baseUrl}/api-keys`, {
      method: "POST", headers, body: JSON.stringify({ tenantId: tenant.id, workspaceId: workspace.id, name: "Escalated tenant administrator" }),
    });

    assert.equal(escalation.status, 403);
    assert.deepEqual(await store.listApiKeys(tenant.id), []);
  } finally { await cp.close(); }
});

it("rejects unauthenticated and cross-tenant management before mutation", async () => {
  const store = new MemoryStore();
  const a = await store.createTenant({ name: "A" });
  const ownWs = (await store.createWorkspace({ tenantId: a.id }))!;
  const b = await store.createTenant({ name: "B" });
  const ws = (await store.createWorkspace({ tenantId: b.id }))!;
  const { profile } = (await store.createProfile({ tenantId: b.id, workspaceId: ws.id, profile: {} }))!;
  const key = await store.createApiKey(a.id, "a-admin");
  const cp = createControlPlaneServer({ store, authMode: "api_key" });
  await once(cp.server, "listening");
  try {
    const requests = [
      ["POST", "/api-keys", { tenantId: b.id, name: "intruder" }],
      ["PUT", `/tenants/${b.id}/gateway`, { allowedProviders: ["intruder"] }],
      ["POST", "/sessions", { tenantId: b.id, profileId: profile.id }],
      ["POST", "/golden-tasks", { profileId: profile.id, input: "poison" }],
      ["GET", `/profiles/${profile.id}/traces`, undefined],
      ["POST", "/skills", { tenantId: b.id, name: "poison", contentHash: "x" }],
      ["POST", "/workspace-members", { tenantId: a.id, workspaceId: ws.id, userId: "attacker", role: "admin" }],
      ["PUT", `/workspaces/${ws.id}/policy`, { tenantId: a.id, workspaceId: ownWs.id, rules: [] }],
      ["GET", `/workspaces/${ws.id}/policy?workspaceId=${ownWs.id}`, undefined],
    ] as const;
    for (const [method, path, body] of requests) {
      for (const token of [undefined, key.key]) {
        const response = await fetch(cp.baseUrl + path, {
          method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        assert.equal(response.status, token ? 403 : 401, `${method} ${path}`);
      }
    }
    assert.equal((await store.listApiKeys(b.id)).length, 0);
    assert.equal((await store.listGoldenTasks(profile.id)).length, 0);
  } finally { await cp.close(); }
});
