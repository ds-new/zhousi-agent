import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { McpConnectionPool } from "../packages/dsh-mcp-pool-plugin/src/connections.js";
import { AgentRuntime } from "../services/data-plane/src/agent-runtime.js";

async function main() {
  const pool = new McpConnectionPool();
  const before = process.memoryUsage().rss;
  const started = performance.now();
  const runtime = new AgentRuntime();
  const constructionMs = performance.now() - started;
  const binding = { serverName: "benchmark", transport: "stdio" as const, command: process.execPath,
    args: [resolve("packages/dsh-mcp-pool-plugin/test/fixtures/mcp-server.mjs")], sensitivity: "normal" as const, poolScope: "workspace" as const };
  const context = { tenantId: "bench", workspaceId: "bench", sessionId: "bench" };
  try {
    const coldStart = performance.now();
    const first = await pool.connect(binding, context);
    await first.listTools();
    const coldMs = performance.now() - coldStart;
    await first.release();
    const warm: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      const lease = await pool.connect(binding, context);
      await lease.listTools();
      warm.push(performance.now() - start);
      await lease.release();
    }
    warm.sort((a, b) => a - b);
    console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
      runtimeConstructionMs: constructionMs, parentRssMiB: process.memoryUsage().rss / 1048576,
      parentRssDeltaMiB: (process.memoryUsage().rss - before) / 1048576,
      mcpColdConnectAndListMs: coldMs, mcpWarmListMedianMs: warm[15], mcpWarmListP95Ms: warm[28],
      note: "Local SDK fixture; excludes child RSS, import/process startup and model inference. Not a production SLO or Pi comparison." }, null, 2));
  } finally { await runtime.close(); await pool.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
