import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createControlPlaneServer } from "../src/server.js";
import { createCpDpHarness } from "./kb-test-helpers.js";
import type { EvolutionRunRequest, EvolutionRunResponse } from "../src/evolution-client.js";

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

describe("Sprint 2a — KB vectors, trace TTL, evolution context", () => {
  const cp = createControlPlaneServer({ port: 0 });

  before(async () => {
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
  });

  after(async () => {
    await cp.close();
  });

  it("ingests and vector-searches internal KB documents via Data Plane proxy", async () => {
    const { cp: cpWithDp, close } = await createCpDpHarness();
    try {
      const { json: tenant } = await request(cpWithDp.baseUrl, "POST", "/tenants", { name: "KbCo" });
      const { json: ws } = await request(cpWithDp.baseUrl, "POST", "/workspaces", { tenantId: tenant.id });
      const { json: profileResult } = await request(cpWithDp.baseUrl, "POST", "/profiles", {
        tenantId: tenant.id,
        workspaceId: ws.id,
        name: "kb-bot",
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;

      await request(cpWithDp.baseUrl, "POST", "/kb/documents", {
        profileId,
        title: "Returns",
        content: "Customers can request a refund within 30 days of purchase.",
      });
      await request(cpWithDp.baseUrl, "POST", "/kb/documents", {
        profileId,
        title: "DevOps",
        content: "Kubernetes cluster scaling and pod autoscaling.",
      });

      const { status, json } = await request(cpWithDp.baseUrl, "POST", "/kb/search", {
        profileId,
        query: "how do refunds work",
      });
      assert.equal(status, 200);
      const hits = json.hits as Array<Record<string, unknown>>;
      assert.ok(hits.length >= 1);
      assert.equal(hits[0]!.title, "Returns");
      assert.equal(hits[0]!.source, "internal");
    } finally {
      await close();
    }
  });

  it("lists traces via GET /profiles/:id/traces", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "TraceCo" });
    const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId: tenant.id });
    const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
      tenantId: tenant.id,
      workspaceId: ws.id,
    });
    const profileId = (profileResult.profile as Record<string, unknown>).id as string;
    const versionId = (profileResult.version as Record<string, unknown>).id as string;

    await request(cp.baseUrl, "POST", "/traces", {
      profileId,
      profileVersionId: versionId,
      output: "answered refund question",
      latencyMs: 120,
      toolCalls: [{ name: "kb_search", ok: true }],
    });

    const { status, json } = await request(cp.baseUrl, "GET", `/profiles/${profileId}/traces`);
    assert.equal(status, 200);
    const traces = json.traces as Array<Record<string, unknown>>;
    assert.equal(traces.length, 1);
    assert.equal(traces[0]!.output, "answered refund question");
  });

  it("passes traces and golden tasks to evolution invoker", async () => {
    let captured: EvolutionRunRequest | null = null;
    const mockCp = createControlPlaneServer({
      port: 0,
      agentGoldenTaskRunner: async () => ({ output: "", latencyMs: 1, toolCalls: [] }),
      evolutionInvoker: async (req): Promise<EvolutionRunResponse> => {
        captured = req;
        return {
          runId: "mock-run",
          status: "completed",
          candidateVersionId: "candidate-1",
          evalScoreDelta: 0.04,
        };
      },
    });
    await new Promise<void>((resolve) => mockCp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(mockCp.baseUrl, "POST", "/tenants", { name: "EvoCtx" });
      const { json: ws } = await request(mockCp.baseUrl, "POST", "/workspaces", {
        tenantId: tenant.id,
      });
      const { json: profileResult } = await request(mockCp.baseUrl, "POST", "/profiles", {
        tenantId: tenant.id,
        workspaceId: ws.id,
        governanceTier: "L1",
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;
      const versionId = (profileResult.version as Record<string, unknown>).id as string;

      for (let i = 0; i < 10; i++) await request(mockCp.baseUrl, "POST", "/golden-tasks", {
        profileId, input: `handle refund ${i}`, expectedContains: ["refund"], split: i >= 5 ? "holdout" : "train",
      });
      await request(mockCp.baseUrl, "POST", "/traces", {
        profileId,
        profileVersionId: versionId,
        output: "",
        latencyMs: 500,
        toolCalls: [{ name: "lookup_order", ok: false }],
      });

      const { status } = await request(mockCp.baseUrl, "POST", "/evolution/runs", {
        tenantId: tenant.id,
        profileId,
        target: "skill",
      });
      assert.equal(status, 201);
      assert.ok(captured);
      assert.equal(captured!.profileId, profileId);
      assert.ok(Array.isArray(captured!.traces));
      assert.equal((captured!.traces as unknown[]).length, 5);
      assert.ok(Array.isArray(captured!.evalTasks));
      assert.equal((captured!.evalTasks as unknown[]).length, 5);
      assert.ok(captured!.snapshot);
    } finally {
      await mockCp.close();
    }
  });
});
