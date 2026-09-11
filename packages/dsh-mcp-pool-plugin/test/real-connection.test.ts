import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { it } from "node:test";
import { McpConnectionPool } from "../src/connections.js";

it("initializes an actual stdio MCP process once and reuses its client", async () => {
  const pool = new McpConnectionPool({ maxConnectionsPerTenant: 1 });
  const binding = { serverName: "fixture", transport: "stdio" as const, command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))] };
  const scope = { tenantId: "t1", workspaceId: "w1", sessionId: "s1" };
  try {
    const [a, b] = await Promise.all([pool.connect(binding, scope), pool.connect(binding, scope)]);
    assert.equal(a.client, b.client);
    assert.equal((await a.client.listTools()).tools[0]?.name, "echo");
    const result = await a.client.callTool({ name: "echo", arguments: { message: "real protocol" } });
    assert.deepEqual(result.content, [{ type: "text", text: "real protocol" }]);
    await a.release(); await b.release();
    const warm = await pool.connect(binding, scope);
    assert.equal(warm.client, a.client);
    await warm.release();
  } finally { await pool.close(); }
});
