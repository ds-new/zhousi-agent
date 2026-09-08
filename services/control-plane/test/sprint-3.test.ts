import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

describe("Sprint 3 — enterprise vault sync, dedicated isolation, profile-sync", () => {
  it("exposes profile-sync entries with snapshots after pin", async () => {
    const cp = createControlPlaneServer({ port: 0 });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", {
        name: "EnterpriseCo",
        isolationMode: "dedicated",
      });
      const tenantId = tenant.id as string;
      assert.equal(tenant.isolationMode, "dedicated");

      const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId });
      const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
        tenantId,
        workspaceId: ws.id,
        name: "enterprise-bot",
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

      const { status, json } = await request(
        cp.baseUrl,
        "GET",
        `/tenants/${tenantId}/profile-sync`,
      );
      assert.equal(status, 200);
      const profiles = json.profiles as Array<Record<string, unknown>>;
      assert.equal(profiles.length, 1);
      assert.equal(profiles[0]!.profileId, profileId);
      assert.equal((profiles[0]!.snapshot as Record<string, unknown>).name, "enterprise-bot");
      assert.ok(profiles[0]!.policy);
      assert.ok(Array.isArray(profiles[0]!.credentialRefIds));
      assert.ok(Array.isArray(profiles[0]!.mcpCatalog));
    } finally {
      await cp.close();
    }
  });

  it("profile.pinned webhook includes snapshot for Data Plane sync", async () => {
    const payloads: Record<string, unknown>[] = [];
    const cp = createControlPlaneServer({
      port: 0,
      webhookFetch: async (_url, init) => {
        payloads.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
        return new Response(null, { status: 200 });
      },
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "SyncCo" });
      const tenantId = tenant.id as string;
      await request(cp.baseUrl, "POST", "/webhooks", {
        tenantId,
        url: "https://data-plane.local/sync",
        events: ["profile.pinned"],
      });
      const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId });
      const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
        tenantId,
        workspaceId: ws.id,
        name: "sync-bot",
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

      const pinPayload = payloads.find((p) => p.event === "profile.pinned");
      assert.ok(pinPayload);
      const payload = pinPayload!.payload as Record<string, unknown>;
      const snapshot = payload.snapshot as Record<string, unknown>;
      assert.equal(snapshot.name, "sync-bot");
      assert.ok(payload.policy);
      assert.ok(Array.isArray(payload.credentialRefIds));
      assert.ok(Array.isArray(payload.mcpCatalog));
      assert.ok(payload.workspaceId);
      assert.ok(payload.tenantId);
    } finally {
      await cp.close();
    }
  });
});
