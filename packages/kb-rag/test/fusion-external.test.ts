import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import type { McpBinding, WorkspaceId } from "@diy-agent/domain";
import { resetInternalIndexForTests } from "../src/internal-kb-store.js";
import { HybridKbService } from "../src/index.js";
import type { McpKbSearchClient } from "../src/external-mcp-kb-connector.js";

describe("kb-rag external MCP + RRF fusion", () => {
  beforeEach(() => {
    resetInternalIndexForTests();
  });

  it("merges internal and external hits via weighted RRF", async () => {
    const ws = "ws-fusion" as WorkspaceId;
    const externalBinding: McpBinding = {
      serverName: "enterprise-search",
      transport: "streamable-http",
      url: "http://mcp-search.local",
      sensitivity: "readonly",
    };
    const mockClient: McpKbSearchClient = {
      async search(_binding, query) {
        assert.equal(query, "refund policy");
        return [
          {
            documentId: "ext-policy-1",
            title: "Enterprise Refund SOP",
            snippet: "All refunds require manager approval above $500.",
            score: 0.9,
            source: "external_mcp",
          },
        ];
      },
    };

    const svc = new HybridKbService(
      {
        internal: { enabled: true },
        externalMcp: externalBinding,
        fusionWeights: { internal: 0.6, external: 0.4 },
      },
      undefined,
      mockClient,
    );

    await svc.ingest(ws, "Returns FAQ", "Our refund policy allows returns within 30 days.");
    const result = await svc.search(ws, "refund policy");

    assert.ok(result.hits.length >= 2);
    const sources = new Set(result.hits.map((h) => h.source));
    assert.ok(sources.has("internal"));
    assert.ok(sources.has("external_mcp"));
  });

  it("HttpMcpKbSearchClient calls MCP search endpoint via pool", async () => {
    const { HttpMcpKbSearchClient } = await import("../src/external-mcp-kb-connector.js");
    const calls: string[] = [];
    const client = new HttpMcpKbSearchClient(async (url, init) => {
      calls.push(url);
      assert.equal(init?.method, "POST");
      return new Response(
        JSON.stringify({
          hits: [
            {
              documentId: "doc-1",
              title: "HR Handbook",
              snippet: "Leave policy section 4",
              score: 0.88,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const binding: McpBinding = {
      serverName: "hr-kb",
      transport: "streamable-http",
      url: "http://mcp-hr.local",
    };
    const hits = await client.search(binding, "leave policy", {
      tenantId: "tenant-1",
      workspaceId: "ws-1",
    });

    assert.equal(calls[0], "http://mcp-hr.local/search");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.source, "external_mcp");
    assert.equal(hits[0]!.title, "HR Handbook");
  });
});
