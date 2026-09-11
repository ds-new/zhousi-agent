import assert from "node:assert/strict";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { McpConnectionPool } from "@diy-agent/dsh-mcp-pool-plugin";
import { ProtocolMcpKbSearchClient } from "../src/protocol-mcp-kb-client.js";

it("retrieves external knowledge through real MCP initialize and tools/call", async () => {
  const pool = new McpConnectionPool();
  try {
    const client = new ProtocolMcpKbSearchClient(pool);
    const hits = await client.search({ serverName: "kb", transport: "stdio", command: process.execPath,
      args: [fileURLToPath(new URL("../../dsh-mcp-pool-plugin/test/fixtures/mcp-server.mjs", import.meta.url))] }, "refund policy",
      { tenantId: "kb-tenant", workspaceId: "kb-workspace", sessionId: "kb-session" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.snippet, "refund policy");
    assert.equal(hits[0]?.source, "external_mcp");
  } finally { await pool.close(); }
});

it("uses the real MCP protocol for the public KB connector default and closes owned resources", async () => {
  const { ExternalMcpKbConnector } = await import("../src/external-mcp-kb-connector.js");
  const connector = new ExternalMcpKbConnector({ serverName: "kb-default", transport: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL("../../dsh-mcp-pool-plugin/test/fixtures/mcp-server.mjs", import.meta.url))] }, undefined,
    { tenantId: "kb-default-tenant", workspaceId: "kb-default-workspace", sessionId: "kb-default-session" });
  try {
    assert.equal((await connector.search("real connector"))[0]?.snippet, "real connector");
  } finally { await connector.close(); }
  await assert.rejects(connector.search("after close"), /mcp_kb_client_closed/);
});
