import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { resetInternalIndexForTests, type McpKbSearchClient } from "@diy-agent/kb-rag";
import { createControlPlaneServer } from "../src/server.js";

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

describe("Sprint 2b — external MCP KB, webhooks, audit log", () => {
  before(() => {
    resetInternalIndexForTests();
  });

  it("fuses internal KB with external MCP search results", async () => {
    const mockClient: McpKbSearchClient = {
      async search() {
        return [
          {
            documentId: "ext-1",
            title: "Enterprise SOP",
            snippet: "Refund escalation process",
            score: 0.95,
            source: "external_mcp",
          },
        ];
      },
    };
    const cp = createControlPlaneServer({ port: 0, mcpKbSearchClient: mockClient });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "FusionCo" });
      const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId: tenant.id });
      const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
        tenantId: tenant.id,
        workspaceId: ws.id,
        kbConfig: {
          internal: { enabled: true },
          externalMcp: {
            serverName: "enterprise-search",
            transport: "streamable-http",
            url: "http://search.local",
            sensitivity: "readonly",
          },
          fusionWeights: { internal: 0.6, external: 0.4 },
        },
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;

      await request(cp.baseUrl, "POST", "/kb/documents", {
        profileId,
        title: "Returns FAQ",
        content: "Refund within 30 days.",
      });

      const { status, json } = await request(cp.baseUrl, "POST", "/kb/search", {
        profileId,
        query: "refund escalation",
      });
      assert.equal(status, 200);
      const hits = json.hits as Array<Record<string, unknown>>;
      assert.ok(hits.length >= 2);
      assert.ok(hits.some((hit) => hit.source === "external_mcp"));
      assert.ok(hits.some((hit) => hit.source === "internal"));
    } finally {
      await cp.close();
    }
  });

  it("dispatches registered webhooks for profile.pinned", async () => {
    const deliveries: Array<{ url: string; body: string; event: string }> = [];
    const cp = createControlPlaneServer({
      port: 0,
      webhookFetch: async (url, init) => {
        deliveries.push({
          url,
          body: init?.body ?? "",
          event: init?.headers?.["X-DIY-Event"] ?? "",
        });
        return new Response(null, { status: 200 });
      },
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "HookCo" });
      const tenantId = tenant.id as string;
      await request(cp.baseUrl, "POST", "/webhooks", {
        tenantId,
        url: "https://hooks.example/pin",
        events: ["profile.pinned"],
      });
      const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId });
      const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
        tenantId,
        workspaceId: ws.id,
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;
      for (let i = 0; i < 5; i++) {
        await request(cp.baseUrl, "POST", "/golden-tasks", {
          profileId,
          input: `task-${i}`,
          expectedContains: ["ok"],
        });
      }
      await request(cp.baseUrl, "POST", `/profiles/${profileId}/pin`, { tenantId });
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]!.event, "profile.pinned");
      assert.match(deliveries[0]!.body, /profileId/);
    } finally {
      await cp.close();
    }
  });

  it("fires quota.warning webhook once per day at 80% usage", async () => {
    const events: string[] = [];
    const cp = createControlPlaneServer({
      port: 0,
      webhookFetch: async (_url, init) => {
        events.push(init?.headers?.["X-DIY-Event"] ?? "");
        return new Response(null, { status: 200 });
      },
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", {
        name: "QuotaCo",
        gateway: { allowedProviders: ["openai"], maxTokensPerDay: 100 },
      });
      const tenantId = tenant.id as string;
      await request(cp.baseUrl, "POST", "/webhooks", {
        tenantId,
        url: "https://hooks.example/quota",
        events: ["quota.warning"],
      });
      const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId });
      const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
        tenantId,
        workspaceId: ws.id,
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;
      const versionId = (profileResult.version as Record<string, unknown>).id as string;

      await request(cp.baseUrl, "POST", "/traces", {
        tenantId,
        profileId,
        profileVersionId: versionId,
        output: "ok",
        latencyMs: 10,
        tokensUsed: 85,
      });
      await request(cp.baseUrl, "POST", "/traces", {
        tenantId,
        profileId,
        profileVersionId: versionId,
        output: "ok",
        latencyMs: 10,
        tokensUsed: 1,
      });

      assert.deepEqual(events, ["quota.warning"]);
    } finally {
      await cp.close();
    }
  });

  it("lists structured audit events without conversation content", async () => {
    const cp = createControlPlaneServer({ port: 0 });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "AuditCo" });
      const tenantId = tenant.id as string;
      const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId });
      const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
        tenantId,
        workspaceId: ws.id,
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;
      for (let i = 0; i < 5; i++) {
        await request(cp.baseUrl, "POST", "/golden-tasks", {
          profileId,
          input: `task-${i}`,
          expectedContains: ["ok"],
        });
      }
      await request(cp.baseUrl, "POST", `/profiles/${profileId}/pin`, { tenantId });
      await request(cp.baseUrl, "POST", "/audit", {
        tenantId,
        action: "policy.ask_resolved",
        metadata: { tool: "write_file", decision: "allow" },
      });

      const { status, json } = await request(cp.baseUrl, "GET", `/audit?tenantId=${tenantId}`);
      assert.equal(status, 200);
      const events = json.events as Array<Record<string, unknown>>;
      const actions = events.map((event) => event.action);
      assert.ok(actions.includes("profile.pinned"));
      assert.ok(actions.includes("policy.ask_resolved"));
      for (const event of events) {
        assert.ok(!("content" in (event.metadata ?? {})));
      }
    } finally {
      await cp.close();
    }
  });
});
