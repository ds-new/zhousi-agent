import { executeFixtureBenchmark } from "./fixtures/agent-runner.js";
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createControlPlaneServer } from "../src/server.js";
import type { EvolutionRunResponse } from "../src/evolution-client.js";

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("control-plane HTTP seam", () => {
  const cp = createControlPlaneServer({ port: 0 });

  before(async () => {
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
  });

  after(async () => {
    await cp.close();
  });

  it("creates tenant → workspace → profile → session lifecycle", async () => {
    const { status: h, json: health } = await request(cp.baseUrl, "GET", "/health");
    assert.equal(h, 200);
    assert.equal(health.ok, true);

    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "Acme" });
    const tenantId = tenant.id as string;

    const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", {
      tenantId,
      name: "default",
    });
    const workspaceId = ws.id as string;

    const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
      tenantId,
      workspaceId,
      name: "support-bot",
      modelRoute: { provider: "openai", model: "gpt-4o-mini" },
    });
    const profileId = (profileResult.profile as Record<string, unknown>).id as string;
    const versionId = (profileResult.version as Record<string, unknown>).id as string;

    for (let i = 0; i < 5; i++) {
      await request(cp.baseUrl, "POST", "/golden-tasks", {
        profileId,
        input: `task-${i}`,
        expectedContains: ["ok"],
      });
    }
    await executeFixtureBenchmark(cp.store, profileId, versionId);
    const { status: pinStatus } = await request(cp.baseUrl, "POST", `/profiles/${profileId}/pin`, {
      tenantId,
    });
    assert.equal(pinStatus, 200);

    const { status: sessionStatus, json: sessionResult } = await request(cp.baseUrl, "POST", "/sessions", {
      tenantId,
      profileId,
    });
    assert.equal(sessionStatus, 201);
    assert.ok(sessionResult.sessionToken);
    assert.equal(
      (sessionResult.dshMeta as Record<string, string>)["diy.profileVersionId"],
      versionId,
    );

    const { json: version } = await request(
      cp.baseUrl,
      "GET",
      `/profiles/${profileId}/versions/${versionId}`,
    );
    assert.equal((version.snapshot as Record<string, unknown>).name, "support-bot");
  });

  it("rejects disallowed model provider", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", {
      name: "Strict",
      gateway: { allowedProviders: ["deepseek"] },
    });
    const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", {
      tenantId: tenant.id,
    });
    const { status, json } = await request(cp.baseUrl, "POST", "/profiles", {
      tenantId: tenant.id,
      workspaceId: ws.id,
      modelRoute: { provider: "openai", model: "gpt-4o-mini" },
    });
    assert.equal(status, 403);
    assert.equal(json.error, "model_provider_not_allowed");
  });

  it("blocks pin when fewer than 5 golden tasks", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "PinCo" });
    const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId: tenant.id });
    const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
      tenantId: tenant.id,
      workspaceId: ws.id,
    });
    const profileId = (profileResult.profile as Record<string, unknown>).id as string;

    const { status, json } = await request(cp.baseUrl, "POST", `/profiles/${profileId}/pin`, {
      tenantId: tenant.id,
    });
    assert.equal(status, 400);
    assert.match(json.error as string, /requires_at_least_5/);
  });

  it("returns 502 when evolution service fails (no mock fallback)", async () => {
    const failingCp = createControlPlaneServer({
      port: 0,
      evolutionInvoker: async () => {
        throw new Error("evolution_http_503");
      },
    });
    await new Promise<void>((resolve) => failingCp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(failingCp.baseUrl, "POST", "/tenants", { name: "Evo" });
      const { json: ws } = await request(failingCp.baseUrl, "POST", "/workspaces", {
        tenantId: tenant.id,
      });
      const { json: profileResult } = await request(failingCp.baseUrl, "POST", "/profiles", {
        tenantId: tenant.id,
        workspaceId: ws.id,
        governanceTier: "L1",
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;
      const { status, json } = await request(failingCp.baseUrl, "POST", "/evolution/runs", {
        tenantId: tenant.id,
        profileId,
      });
      assert.equal(status, 502);
      assert.equal(json.error, "evolution_service_unavailable");
    } finally {
      await failingCp.close();
    }
  });

  it("keeps unmeasured evolution candidates pending review", async () => {
    const mockCp = createControlPlaneServer({
      port: 0,
      evolutionInvoker: async (): Promise<EvolutionRunResponse> => ({
        runId: "mock-run",
        status: "completed",
        candidateVersionId: "candidate-1",
        evalScoreDelta: 0.05,
      }),
    });
    await new Promise<void>((resolve) => mockCp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(mockCp.baseUrl, "POST", "/tenants", { name: "EvoOk" });
      const { json: ws } = await request(mockCp.baseUrl, "POST", "/workspaces", {
        tenantId: tenant.id,
      });
      const { json: profileResult } = await request(mockCp.baseUrl, "POST", "/profiles", {
        tenantId: tenant.id,
        workspaceId: ws.id,
        governanceTier: "L1",
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;
      const { status, json } = await request(mockCp.baseUrl, "POST", "/evolution/runs", {
        tenantId: tenant.id,
        profileId,
      });
      assert.equal(status, 201);
      assert.equal((json.run as Record<string, unknown>).status, "awaiting_review");
      assert.equal((json.run as Record<string, unknown>).evalScoreDelta, 0);
    } finally {
      await mockCp.close();
    }
  });
});
