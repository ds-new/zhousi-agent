import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { generateServiceAccountToken, signDevHs256Jwt } from "@diy-agent/auth";
import { createControlPlaneServer } from "../src/server.js";

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

describe("Phase 3 — marketplace, evolution guard, service account", () => {
  const serviceToken = generateServiceAccountToken();
  const platformKey = "diy_pa_test_platform_key";
  const jwksSecret = "phase3-jwks-secret";
  const cp = createControlPlaneServer({
    port: 0,
    authMode: "api_key",
    serviceAccountMode: "token",
    serviceAccountToken: serviceToken,
    platformAdminKey: platformKey,
    jwksOidc: {
      issuer: "https://idp.example.com",
      audience: "diy-agent",
      hs256Secrets: { dev: jwksSecret },
    },
    evolutionInvoker: async () => ({
      runId: "evo-mock",
      status: "completed",
      evalScoreDelta: 0.1,
      requiresReview: false,
    }),
  });

  before(async () => {
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
  });

  after(async () => {
    await cp.close();
  });

  it("publishes marketplace skills and lets tenants subscribe", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "MarketCo" });
    const tenantId = tenant.id as string;
    const { json: keyResult } = await request(cp.baseUrl, "POST", "/api-keys", {
      tenantId,
      name: "admin",
    });
    const apiKey = keyResult.key as string;

    const { status: deniedPublish } = await request(
      cp.baseUrl,
      "POST",
      "/marketplace/skills",
      { slug: "research", name: "Research Assistant", contentHash: "abc123" },
      { Authorization: `Bearer ${apiKey}` },
    );
    assert.equal(deniedPublish, 401);

    const { status: publishStatus, json: published } = await request(
      cp.baseUrl,
      "POST",
      "/marketplace/skills",
      {
        slug: "research",
        name: "Research Assistant",
        contentHash: "abc123",
        version: "1.0.0",
      },
      { Authorization: `Bearer ${platformKey}` },
    );
    assert.equal(publishStatus, 201);
    const marketplaceSkillId = published.id as string;

    const { json: catalog } = await request(cp.baseUrl, "GET", "/marketplace/skills");
    assert.equal((catalog.skills as unknown[]).length, 1);

    const headers = { Authorization: `Bearer ${apiKey}` };
    await request(
      cp.baseUrl,
      "POST",
      "/marketplace/subscriptions",
      { tenantId, marketplaceSkillId },
      headers,
    );

    const { json: skills } = await request(
      cp.baseUrl,
      "GET",
      `/skills?tenantId=${tenantId}`,
      undefined,
      headers,
    );
    const skillList = skills.skills as Array<Record<string, unknown>>;
    assert.ok(skillList.some((s) => s.source === "marketplace" && s.id === marketplaceSkillId));
  });

  it("blocks L1 evolution on marketplace skills but allows workspace-private skills", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "EvoCo" });
    const tenantId = tenant.id as string;
    const { json: keyResult } = await request(cp.baseUrl, "POST", "/api-keys", {
      tenantId,
      name: "admin",
    });
    const apiKey = keyResult.key as string;
    const headers = { Authorization: `Bearer ${apiKey}` };

    const { json: published } = await request(
      cp.baseUrl,
      "POST",
      "/marketplace/skills",
      { slug: "sales", name: "Sales Playbook", contentHash: "hash-sales" },
      { Authorization: `Bearer ${platformKey}` },
    );
    const marketplaceSkillId = published.id as string;
    await request(
      cp.baseUrl,
      "POST",
      "/marketplace/subscriptions",
      { tenantId, marketplaceSkillId },
      headers,
    );

    const { json: ws } = await request(
      cp.baseUrl,
      "POST",
      "/workspaces",
      { tenantId, creatorUserId: "admin@corp.com" },
      headers,
    );
    const workspaceId = ws.id as string;

    const { json: privateSkill } = await request(cp.baseUrl, "POST", "/skills", {
      tenantId,
      workspaceId,
      name: "team-runbook",
      contentHash: "team-hash",
      source: "private",
    });

    const { json: profileResult } = await request(
      cp.baseUrl,
      "POST",
      "/profiles",
      { tenantId, workspaceId, governanceTier: "L1" },
      headers,
    );
    const profileId = (profileResult.profile as Record<string, unknown>).id as string;

    const { status: blocked } = await request(
      cp.baseUrl,
      "POST",
      "/evolution/runs",
      {
        tenantId,
        profileId,
        tier: "L1",
        target: "skill",
        skillId: marketplaceSkillId,
      },
      headers,
    );
    assert.equal(blocked, 403);

    const { status: allowed } = await request(
      cp.baseUrl,
      "POST",
      "/evolution/runs",
      {
        tenantId,
        profileId,
        tier: "L1",
        target: "skill",
        skillId: privateSkill.id as string,
      },
      headers,
    );
    assert.equal(allowed, 201);
  });

  it("requires service account token for trace upload and profile sync pull", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "SaCo" });
    const tenantId = tenant.id as string;

    const { status: noAuthTrace } = await request(cp.baseUrl, "POST", "/traces", {
      profileId: "missing",
      profileVersionId: "v1",
      latencyMs: 10,
    });
    assert.equal(noAuthTrace, 401);

    const saHeaders = { Authorization: `Bearer ${serviceToken}` };
    const { status: syncStatus } = await request(
      cp.baseUrl,
      "GET",
      `/tenants/${tenantId}/profile-sync`,
      undefined,
      saHeaders,
    );
    assert.equal(syncStatus, 200);
  });

  it("accepts JWKS OIDC tokens for tenant auth", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "JwksCo" });
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
      { tenantId, creatorUserId: "admin@corp.com" },
      { Authorization: `Bearer ${apiKey}` },
    );
    await request(
      cp.baseUrl,
      "POST",
      "/workspace-members",
      {
        tenantId,
        workspaceId: ws.id,
        userId: "builder@corp.com",
        role: "builder",
      },
      { Authorization: `Bearer ${apiKey}` },
    );

    const jwt = signDevHs256Jwt(
      {
        iss: "https://idp.example.com",
        aud: "diy-agent",
        sub: "builder@corp.com",
        tenant_id: tenantId,
      },
      jwksSecret,
    );

    const { status } = await request(
      cp.baseUrl,
      "POST",
      "/profiles",
      { tenantId, workspaceId: ws.id, name: "jwks-bot" },
      { Authorization: `Bearer ${jwt}` },
    );
    assert.equal(status, 201);
  });

  it("requires service account for MCP catalog GET", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "McpCatalogCo" });
    const tenantId = tenant.id as string;

    const { status: anonStatus } = await request(
      cp.baseUrl,
      "GET",
      `/mcp/catalog?tenantId=${tenantId}`,
    );
    assert.equal(anonStatus, 401);

    const { status: authedStatus } = await request(
      cp.baseUrl,
      "GET",
      `/mcp/catalog?tenantId=${tenantId}`,
      undefined,
      { Authorization: `Bearer ${serviceToken}` },
    );
    assert.equal(authedStatus, 200);
  });
});
