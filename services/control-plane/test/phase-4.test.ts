import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { generateServiceAccountToken } from "@diy-agent/auth";
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

describe("Phase 4 — profile eval run, policy snapshot, eval history", () => {
  const serviceToken = generateServiceAccountToken();
  const cp = createControlPlaneServer({
    port: 0,
    serviceAccountMode: "token",
    serviceAccountToken: serviceToken,
  });

  before(async () => {
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
  });

  after(async () => {
    await cp.close();
  });

  it("runs profile evaluation and persists eval history", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "EvalCo" });
    const tenantId = tenant.id as string;
    const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId });
    const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
      tenantId,
      workspaceId: ws.id,
      mcpBindings: [{ serverName: "github", transport: "stdio", envRef: { TOKEN: "vault://gh" } }],
    });
    const profileId = (profileResult.profile as Record<string, unknown>).id as string;
    const versionId = (profileResult.version as Record<string, unknown>).id as string;

    for (let i = 0; i < 5; i++) {
      await request(cp.baseUrl, "POST", "/golden-tasks", {
        profileId,
        input: `task-${i}`,
        expectedContains: ["ok"],
      });
      await cp.store.saveTrace({
        profileId,
        profileVersionId: versionId as import("@diy-agent/domain").ProfileVersionId,
        output: "ok",
        latencyMs: 50,
        toolCalls: [{ name: "tool", ok: true }],
      });
    }

    const { status, json } = await request(
      cp.baseUrl,
      "POST",
      `/profiles/${profileId}/eval/run`,
      { tenantId },
    );
    assert.equal(status, 200);
    const gate = json.gate as Record<string, unknown>;
    assert.ok(typeof gate.passRate === "number");
    assert.ok(json.evalRun);

    const { json: history } = await request(cp.baseUrl, "GET", `/profiles/${profileId}/eval/runs`);
    assert.equal((history.runs as unknown[]).length, 1);
  });

  it("returns workspace policy and credential refs in profile version snapshot", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "SnapCo" });
    const tenantId = tenant.id as string;
    const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId });
    const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
      tenantId,
      workspaceId: ws.id,
      modelRoute: { provider: "openai", model: "gpt-4o-mini", apiKeyRef: "vault://openai" },
      mcpBindings: [{ serverName: "kb", transport: "stdio", envRef: { KEY: "vault://kb" } }],
    });
    const profileId = (profileResult.profile as Record<string, unknown>).id as string;
    const versionId = (profileResult.version as Record<string, unknown>).id as string;
    const saHeaders = { Authorization: `Bearer ${serviceToken}` };

    const { status, json } = await request(
      cp.baseUrl,
      "GET",
      `/profiles/${profileId}/versions/${versionId}`,
      undefined,
      saHeaders,
    );
    assert.equal(status, 200);
    const policy = json.policy as Record<string, unknown>;
    assert.ok(Array.isArray(policy.rules));
    const refs = json.credentialRefIds as string[];
    assert.ok(refs.includes("vault://openai"));
    assert.ok(refs.includes("vault://kb"));
  });

  it("seeds default deny-by-default workspace policy on create", async () => {
    const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "PolicyCo" });
    const tenantId = tenant.id as string;
    const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId });
    const { json: policy } = await request(cp.baseUrl, "GET", `/workspaces/${ws.id}/policy`);
    const rules = policy.rules as Array<Record<string, unknown>>;
    assert.ok(rules.some((r) => r.effect === "deny" && r.sensitivity === "high"));
  });
});
