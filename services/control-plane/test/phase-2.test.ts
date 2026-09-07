import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createControlPlaneServer } from "../src/server.js";
import type { EvolutionRunResponse } from "../src/evolution-client.js";

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("Phase 2 — auth, RBAC, evolution approve, access policy", () => {
  const cp = createControlPlaneServer({ port: 0, authMode: "api_key" });

  before(async () => {
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
  });

  after(async () => {
    await cp.close();
  });

  it("rejects protected routes without API key", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "NoAuth" });
    const { status } = await request(cp.baseUrl, "POST", "/workspaces", {
      tenantId: tenant.id,
    });
    assert.equal(status, 401);
  });

  it("supports API key and OIDC auth with workspace RBAC", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "AuthCo" });
    const tenantId = tenant.id as string;

    const { json: keyResult } = await request(cp.baseUrl, "POST", "/api-keys", {
      tenantId,
      name: "admin",
    });
    const apiKey = keyResult.key as string;

    const { json: ws } = await request(
      cp.baseUrl,
      "POST",
      "/workspaces",
      { tenantId, name: "team-a", creatorUserId: "admin@corp.com" },
      { Authorization: `Bearer ${apiKey}` },
    );

    await request(
      cp.baseUrl,
      "POST",
      "/workspace-members",
      { tenantId, workspaceId: ws.id, userId: "builder@corp.com", role: "builder" },
      { Authorization: `Bearer ${apiKey}` },
    );
    await request(
      cp.baseUrl,
      "POST",
      "/workspace-members",
      { tenantId, workspaceId: ws.id, userId: "viewer@corp.com", role: "user" },
      { Authorization: `Bearer ${apiKey}` },
    );

    const { status: denied } = await request(
      cp.baseUrl,
      "POST",
      "/profiles",
      { tenantId, workspaceId: ws.id, name: "blocked-bot" },
      { Authorization: `Bearer oidc.${tenantId}.viewer@corp.com` },
    );
    assert.equal(denied, 403);

    const { status: allowed } = await request(
      cp.baseUrl,
      "POST",
      "/profiles",
      { tenantId, workspaceId: ws.id, name: "builder-bot" },
      { Authorization: `Bearer oidc.${tenantId}.builder@corp.com` },
    );
    assert.equal(allowed, 201);
  });

  it("stores workspace access policy and approves L2 evolution runs", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "PolicyCo" });
    const tenantId = tenant.id as string;
    const { json: keyResult } = await request(cp.baseUrl, "POST", "/api-keys", {
      tenantId,
      name: "admin",
    });
    const apiKey = keyResult.key as string;
    const headers = { Authorization: `Bearer ${apiKey}` };

    const { json: ws } = await request(
      cp.baseUrl,
      "POST",
      "/workspaces",
      { tenantId, creatorUserId: "admin@corp.com" },
      headers,
    );
    await request(
      cp.baseUrl,
      "PUT",
      `/workspaces/${ws.id}/policy`,
      {
        tenantId,
        rules: [{ effect: "allow", toolPattern: "*readonly*", sensitivity: "readonly" }],
      },
      headers,
    );
    const { json: policy } = await request(
      cp.baseUrl,
      "GET",
      `/workspaces/${ws.id}/policy`,
    );
    assert.equal((policy.rules as unknown[]).length, 1);

    const mockCp = createControlPlaneServer({
      port: 0,
      authMode: "api_key",
      evolutionInvoker: async (): Promise<EvolutionRunResponse> => ({
        runId: "evo-1",
        status: "awaiting_review",
        candidateVersionId: "candidate-v2",
        requiresReview: true,
      }),
    });
    await new Promise<void>((resolve) => mockCp.server.once("listening", resolve));
    try {
      const { json: t2 } = await request(mockCp.baseUrl, "POST", "/tenants", { name: "EvoCo" });
      const tId = t2.id as string;
      const { json: k2 } = await request(mockCp.baseUrl, "POST", "/api-keys", {
        tenantId: tId,
        name: "admin",
      });
      const h = { Authorization: `Bearer ${k2.key as string}` };
      const { json: ws2 } = await request(
        mockCp.baseUrl,
        "POST",
        "/workspaces",
        { tenantId: tId, creatorUserId: "admin@corp.com" },
        h,
      );
      const { json: profileResult } = await request(
        mockCp.baseUrl,
        "POST",
        "/profiles",
        { tenantId: tId, workspaceId: ws2.id, governanceTier: "L2" },
        h,
      );
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;
      const { json: evoResult } = await request(
        mockCp.baseUrl,
        "POST",
        "/evolution/runs",
        { tenantId: tId, profileId, tier: "L2" },
        h,
      );
      const runId = (evoResult.run as Record<string, unknown>).id as string;
      const { status, json: approved } = await request(
        mockCp.baseUrl,
        "POST",
        `/evolution/runs/${runId}/approve`,
        { tenantId: tId, reviewer: "admin@corp.com" },
        h,
      );
      assert.equal(status, 200);
      assert.equal(approved.status, "completed");
    } finally {
      await mockCp.close();
    }
  });

  it("returns orchestration collaboration metrics", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "OrchCo" });
    const tenantId = tenant.id as string;
    const { json: keyResult } = await request(cp.baseUrl, "POST", "/api-keys", {
      tenantId,
      name: "admin",
    });
    const headers = { Authorization: `Bearer ${keyResult.key as string}` };
    const { json: ws } = await request(
      cp.baseUrl,
      "POST",
      "/workspaces",
      { tenantId },
      headers,
    );
    const { json: profileResult } = await request(
      cp.baseUrl,
      "POST",
      "/profiles",
      { tenantId, workspaceId: ws.id },
      headers,
    );
    const profileId = (profileResult.profile as Record<string, unknown>).id as string;
    const { status, json } = await request(
      cp.baseUrl,
      "POST",
      "/orchestration/run",
      {
        profileId,
        goal: "multi-step research task",
        orchestration: { topology: "pipeline", workerProfileIds: ["w1", "w2"] },
      },
      headers,
    );
    assert.equal(status, 200);
    const metrics = json.metrics as Record<string, number>;
    assert.ok(metrics.handoffCount >= 1);
    assert.equal(metrics.workerCount, 2);
  });
});
