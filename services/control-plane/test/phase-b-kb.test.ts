import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createControlPlaneServer } from "../src/server.js";
import { createCpDpHarness } from "./kb-test-helpers.js";
import { computeKbContentHash } from "../src/kb-registry.js";

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

describe("Phase B — Kb Document Registry + ingest orchestration", () => {
  it("writes registry metadata after Data Plane ingest without content", async () => {
    const { cp, close } = await createCpDpHarness();
    try {
      const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "RegCo" });
      const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId: tenant.id });
      const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
        tenantId: tenant.id,
        workspaceId: ws.id,
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;
      const content = "Refund within 30 days of purchase.";

      const ingest = await request(cp.baseUrl, "POST", "/kb/documents", {
        profileId,
        title: "Returns",
        content,
      });
      assert.equal(ingest.status, 201);
      assert.equal(ingest.json.title, "Returns");
      assert.equal(ingest.json.contentHash, computeKbContentHash(content));
      assert.ok(ingest.json.id);
      assert.equal(ingest.json.content, undefined);

      const list = await request(cp.baseUrl, "GET", `/profiles/${profileId}/kb/documents`);
      assert.equal(list.status, 200);
      const documents = list.json.documents as Array<Record<string, unknown>>;
      assert.equal(documents.length, 1);
      assert.equal(documents[0]!.title, "Returns");
      assert.equal(documents[0]!.contentHash, computeKbContentHash(content));
      assert.equal(documents[0]!.content, undefined);
    } finally {
      await close();
    }
  });

  it("does not write registry when Data Plane ingest fails", async () => {
    const cp = createControlPlaneServer({
      port: 0,
      dataPlaneUrl: "http://127.0.0.1:1",
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    try {
      const { json: tenant } = await request(cp.baseUrl, "POST", "/tenants", { name: "FailCo" });
      const { json: ws } = await request(cp.baseUrl, "POST", "/workspaces", { tenantId: tenant.id });
      const { json: profileResult } = await request(cp.baseUrl, "POST", "/profiles", {
        tenantId: tenant.id,
        workspaceId: ws.id,
      });
      const profileId = (profileResult.profile as Record<string, unknown>).id as string;

      const ingest = await request(cp.baseUrl, "POST", "/kb/documents", {
        profileId,
        title: "Returns",
        content: "some content",
      });
      assert.equal(ingest.status, 502);

      const list = await request(cp.baseUrl, "GET", `/profiles/${profileId}/kb/documents`);
      assert.equal(list.status, 200);
      const documents = list.json.documents as unknown[];
      assert.equal(documents.length, 0);
    } finally {
      await cp.close();
    }
  });
});
