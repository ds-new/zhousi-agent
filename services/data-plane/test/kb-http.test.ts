import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import { resetInternalIndexForTests } from "@diy-agent/kb-rag";
import { createDataPlaneServer } from "../src/server.js";

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("Data Plane KB HTTP", () => {
  beforeEach(() => resetInternalIndexForTests());

  it("ingests and searches documents on POST /kb/search", async () => {
    const dp = createDataPlaneServer({ port: 0 });
    await new Promise<void>((resolve) => dp.server.once("listening", resolve));
    try {
      const workspaceId = "ws-dp-1";
      const kbConfig = { internal: { enabled: true } };

      const ingest = await request(dp.baseUrl, "POST", "/kb/documents", {
        workspaceId,
        title: "Returns",
        content: "Customers can request a refund within 30 days.",
        kbConfig,
      });
      assert.equal(ingest.status, 201);

      const search = await request(dp.baseUrl, "POST", "/kb/search", {
        workspaceId,
        query: "how do refunds work",
        kbConfig,
      });
      assert.equal(search.status, 200);
      const hits = search.json.hits as Array<Record<string, unknown>>;
      assert.ok(hits.length >= 1);
      assert.equal(hits[0]!.title, "Returns");
    } finally {
      await dp.close();
    }
  });

  it("rejects requests when internal token is required and missing", async () => {
    const dp = createDataPlaneServer({ port: 0, internalToken: "secret-token" });
    await new Promise<void>((resolve) => dp.server.once("listening", resolve));
    try {
      const { status } = await request(dp.baseUrl, "POST", "/kb/search", {
        workspaceId: "ws-1",
        query: "test",
        kbConfig: { internal: { enabled: true } },
      });
      assert.equal(status, 401);
    } finally {
      await dp.close();
    }
  });
});
