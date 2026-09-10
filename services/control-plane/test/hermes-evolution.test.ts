import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import type { ProfileVersionId } from "@diy-agent/domain";
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

describe("Hermes evolution closure", () => {
  it("auto-applies L1 mutations and creates candidate profile version", async () => {
    const cp = createControlPlaneServer({
      port: 0,
      evolutionInvoker: async (): Promise<EvolutionRunResponse> => ({
        runId: "evo-mock",
        status: "completed",
        candidateVersionId: "candidate-evolved",
        evalScoreDelta: 0.04,
        mutations: [
          {
            path: "prompt/system",
            before: "You are a helpful assistant.",
            after: "You are a helpful assistant.\n\nValidate tool inputs before calling.",
            tier: "L1",
          },
        ],
      }),
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "HermesCo" });
      const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId: tenant.id });
      const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
        tenantId: tenant.id,
        workspaceId: ws.id,
        governanceTier: "L1",
        systemPrompt: "You are a helpful assistant.",
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;

      const { status, json } = await request(cp.baseUrl, "POST", "/evolution/runs", {
        tenantId: tenant.id,
        profileId,
        target: "prompt",
      });
      assert.equal(status, 201);
      const run = json.run as Record<string, unknown>;
      assert.equal(run.status, "completed");
      assert.equal(run.candidateVersionId, "candidate-evolved");

      const { json: version } = await request(
        cp.baseUrl,
        "GET",
        `/profiles/${profileId}/versions/candidate-evolved`,
      );
      assert.match(
        (version.snapshot as Record<string, unknown>).systemPrompt as string,
        /Validate tool inputs/,
      );
    } finally {
      await cp.close();
    }
  });

  it("triggers evolution from failed eval pass rate for L1 profiles", async () => {
    const cp = createControlPlaneServer({
      port: 0,
      evolutionInvoker: async (): Promise<EvolutionRunResponse> => ({
        runId: "evo-signal",
        status: "completed",
        candidateVersionId: "candidate-signal",
        evalScoreDelta: 0.02,
        mutations: [
          {
            path: "mcp/lookup_order/description",
            before: "generic",
            after: "Retry lookup_order with validated ids.",
            tier: "L1",
          },
        ],
      }),
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "SignalCo" });
      const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId: tenant.id });
      const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
        tenantId: tenant.id,
        workspaceId: ws.id,
        governanceTier: "L1",
        mcpBindings: [{ serverName: "lookup_order", transport: "stdio" }],
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;
      for (let i = 0; i < 5; i++) {
        await request(cp.baseUrl, "POST", "/golden-tasks", {
          profileId,
          input: `task-${i}`,
          expectedContains: ["alpha", "beta", "gamma"],
        });
      }

      const { status, json } = await request(cp.baseUrl, "POST", `/profiles/${profileId}/eval/run`, {
        tenantId: tenant.id,
      });
      assert.equal(status, 200);
      assert.ok(json.evolutionRun);
      const evolutionRun = json.evolutionRun as Record<string, unknown>;
      assert.equal(evolutionRun.status, "completed");
      assert.equal(evolutionRun.trigger, "signal");
    } finally {
      await cp.close();
    }
  });

  it("auto-pins candidate after evolution when agent re-eval passes pin gate", async () => {
    const candidateVersionId = "candidate-auto-pin";
    const cp = createControlPlaneServer({
      port: 0,
      evolutionInvoker: async (): Promise<EvolutionRunResponse> => ({
        runId: "evo-auto-pin",
        status: "completed",
        candidateVersionId,
        evalScoreDelta: 0.05,
        engine: "heuristic",
        mutations: [
          {
            path: "prompt/system",
            before: "You are a helpful assistant.",
            after: "You are a helpful assistant.\n\nUse pass-token in responses.",
            tier: "L1",
          },
        ],
      }),
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "PinCo" });
      const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId: tenant.id });
      const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
        tenantId: tenant.id,
        workspaceId: ws.id,
        governanceTier: "L1",
        systemPrompt: "You are a helpful assistant.",
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;

      for (let i = 0; i < 5; i++) {
        await request(cp.baseUrl, "POST", "/golden-tasks", {
          profileId,
          input: `task-${i}`,
          expectedContains: ["pass-token"],
        });
      }

      const { status, json } = await request(cp.baseUrl, "POST", `/profiles/${profileId}/eval/run`, {
        tenantId: tenant.id,
      });
      assert.equal(status, 200);
      assert.ok(json.evolutionRun);
      assert.ok(json.postEvolutionEval);
      const autoPin = json.autoPin as Record<string, unknown>;
      assert.equal(autoPin.ok, true);
      const profile = autoPin.profile as Record<string, unknown>;
      assert.equal(profile.pinnedVersionId, candidateVersionId);

      const postEval = json.postEvolutionEval as Record<string, unknown>;
      const postGate = postEval.gate as Record<string, unknown>;
      assert.equal(postGate.passed, true);
    } finally {
      await cp.close();
    }
  });

  it("auto-pins L2 candidate after admin approve when agent re-eval passes", async () => {
    const candidateVersionId = "candidate-l2-pin";
    const webhookEvents: string[] = [];
    const cp = createControlPlaneServer({
      port: 0,
      webhookFetch: async (_url, init) => {
        webhookEvents.push(init?.headers?.["X-DIY-Event"] ?? "");
        return new Response(null, { status: 200 });
      },
      evolutionInvoker: async (): Promise<EvolutionRunResponse> => ({
        runId: "evo-l2-pin",
        status: "awaiting_review",
        candidateVersionId,
        requiresReview: true,
        gepaRounds: [{ round: 1, passRate: 1 }],
        mutations: [
          {
            path: "prompt/system",
            before: "You are a helpful assistant.",
            after: "You are a helpful assistant.\n\nUse pass-token in responses.",
            tier: "L2",
          },
        ],
      }),
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "L2PinCo" });
      const tenantId = tenant.id as string;
      await request(cp.baseUrl, "POST", "/webhooks", {
        tenantId,
        url: "https://hooks.example/evolution",
        events: ["evolution.approved", "profile.pinned"],
      });
      const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId });
      const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
        tenantId,
        workspaceId: ws.id,
        governanceTier: "L2",
        systemPrompt: "You are a helpful assistant.",
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;

      for (let i = 0; i < 5; i++) {
        await request(cp.baseUrl, "POST", "/golden-tasks", {
          profileId,
          input: `task-${i}`,
          expectedContains: ["pass-token"],
        });
      }

      const { json: evoResult } = await request(
        cp.baseUrl,
        "POST",
        "/evolution/runs",
        { tenantId, profileId, target: "prompt" },
      );
      const runId = (evoResult.run as Record<string, unknown>).id as string;

      const { status, json: approved } = await request(
        cp.baseUrl,
        "POST",
        `/evolution/runs/${runId}/approve`,
        { tenantId, reviewer: "admin@corp.com" },
      );
      assert.equal(status, 200);
      assert.equal(approved.status, "completed");
      assert.ok(approved.postEvolutionEval);
      const autoPin = approved.autoPin as Record<string, unknown>;
      assert.equal(autoPin.ok, true);
      const profile = autoPin.profile as Record<string, unknown>;
      assert.equal(profile.pinnedVersionId, candidateVersionId);
      assert.ok(webhookEvents.includes("evolution.approved"));
      assert.ok(webhookEvents.includes("profile.pinned"));

      const audit = await cp.store.listAuditLog(tenantId);
      const approvedAudit = audit.find((event) => event.action === "evolution.approved");
      assert.ok(approvedAudit);
      assert.equal(
        (approvedAudit!.metadata as Record<string, unknown>).autoPinOk,
        true,
      );
    } finally {
      await cp.close();
    }
  });
});
