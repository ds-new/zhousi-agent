import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentRuntime } from "../src/agent-runtime.js";
import { fileURLToPath } from "node:url";

const profile = { id: "p", workspaceId: "w", systemPrompt: "Answer clearly", modelRoute: { provider: "custom", model: "tiny", baseUrl: "http://model.local/v1" }, skillIds: [], mcpBindings: [], governanceTier: "L1", name: "test" } as const;

it("calls the configured model and isolates session histories across tenants", async () => {
  const calls: unknown[] = [];
  const runtime = new AgentRuntime({ allowedModelOrigins: ["http://model.local"], fetchImpl: async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { role: "assistant", content: "Actual model output" } }], usage: { total_tokens: 7 } });
  } });
  try {
    const input = { tenantId: "a", workspaceId: "w", sessionId: "s", profileVersionId: "v1", snapshot: structuredClone(profile), input: "tenant A secret" };
    const result = await runtime.run(input as never);
    assert.equal(result.output, "Actual model output");
    assert.equal(result.tokensUsed, 7);
    await runtime.run({ ...input, tenantId: "b", input: "tenant B request" } as never);
    assert.ok(!JSON.stringify(calls[1]).includes("tenant A secret"));
    await assert.rejects(runtime.run({ ...input, profileVersionId: "v2" } as never), /session_profile_version_mismatch/);
  } finally { await runtime.close(); }
});

it("does not fall back on quota exhaustion", async () => {
  let calls = 0;
  const runtime = new AgentRuntime({ allowedModelOrigins: ["http://model.local"], fetchImpl: async () => { calls++; return Response.json({}, { status: 429 }); } });
  try {
    await assert.rejects(runtime.run({ tenantId: "a", workspaceId: "w", sessionId: "s", profileVersionId: "v", input: "hello",
      snapshot: { ...profile, modelRoute: { ...profile.modelRoute, fallback: profile.modelRoute } } } as never), /model_http_429/);
    assert.equal(calls, 1);
  } finally { await runtime.close(); }
});

it("runs a real MCP tool between model turns and returns measured tool results", async () => {
  let turn = 0;
  const runtime = new AgentRuntime({ allowedModelOrigins: ["http://model.local"], fetchImpl: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (turn++ === 0) {
      assert.equal(request.tools[0].function.description, "");
      return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: request.tools[0].function.name, arguments: '{"message":"verified tool evidence"}' } }] } }] });
    }
    assert.match(JSON.stringify(request.messages), /verified tool evidence/);
    return Response.json({ choices: [{ message: { role: "assistant", content: "Done with evidence" } }] });
  } });
  const binding = { serverName: "echo", transport: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL("../../../packages/dsh-mcp-pool-plugin/test/fixtures/mcp-server.mjs", import.meta.url))] };
  try {
    const result = await runtime.run({ tenantId: "a", workspaceId: "w", sessionId: "tools", profileVersionId: "v", input: "use echo",
      snapshot: { ...profile, mcpBindings: [binding] }, mcpCatalog: [{ ...binding, tenantId: "a", approvalStatus: "approved" }] } as never);
    assert.equal(result.output, "Done with evidence");
    assert.deepEqual(result.toolCalls, [{ name: "mcp__echo__echo", ok: true }]);
    assert.equal(turn, 2);
  } finally { await runtime.close(); }
});
