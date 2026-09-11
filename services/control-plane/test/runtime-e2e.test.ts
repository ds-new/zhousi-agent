import assert from "node:assert/strict";
import { it } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneServer } from "../src/server.js";
import { createDataPlaneAgentRunner } from "../src/agent-client.js";
import { createDataPlaneServer } from "../../data-plane/src/server.js";
import { AgentRuntime } from "../../data-plane/src/agent-runtime.js";
import { LocalFiles } from "../../data-plane/src/local-files.js";
import { runGoldenTaskAgentEval } from "../src/golden-task-runner.js";

it("executes CP golden tasks and authorized user sessions through DP and a real local model HTTP server", async () => {
  const requests: Record<string, unknown>[] = [];
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "verified-answer" } }], usage: { total_tokens: 12 } }));
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  const origin = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
  const dir = await mkdtemp(join(tmpdir(), "diy-runtime-e2e-"));
  const files = new LocalFiles(dir);
  const runtime = new AgentRuntime({ allowedModelOrigins: [origin], files });
  const cp = createControlPlaneServer(); await once(cp.server, "listening");
  const dp = createDataPlaneServer({ internalToken: "local-service-token", controlPlaneUrl: cp.baseUrl, files, agentRuntime: runtime });
  await once(dp.server, "listening");
  try {
    const tenant = await cp.store.createTenant({ name: "runtime", gateway: { allowedProviders: ["custom"] } });
    const ws = (await cp.store.createWorkspace({ tenantId: tenant.id }))!;
    const hash = await files.putSkill(tenant.id, "# Skill\nCheck the evidence.");
    const skill = await cp.store.registerSkill({ tenantId: tenant.id, workspaceId: ws.id, name: "evidence", source: "private", contentHash: hash });
    const { profile, version } = (await cp.store.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {
      skillIds: [skill.id], modelRoute: { provider: "custom", model: "tiny", baseUrl: origin + "/v1" },
    } }))!;
    await cp.store.pinProfile(profile.id, version.id);
    for (let i = 0; i < 5; i++) await cp.store.createGoldenTask({ profileId: profile.id, input: `task ${i}`, expectedContains: ["verified-answer"] });
    const evaluated = await runGoldenTaskAgentEval(cp.store, { profileId: profile.id, profileVersionId: version.id, snapshot: profile,
      agentRunner: createDataPlaneAgentRunner(cp.store, { url: dp.baseUrl, token: "local-service-token" }) });
    assert.equal(evaluated.passRate, 1);
    assert.ok(!JSON.stringify(requests).includes("expectedContains"));
    assert.match(JSON.stringify(requests), /Check the evidence/);
    const session = (await cp.store.createSession({ tenantId: tenant.id, profileId: profile.id }))!;
    const other = (await cp.store.createSession({ tenantId: tenant.id, profileId: profile.id }))!;
    const turn = (id: string) => fetch(`${dp.baseUrl}/sessions/${id}/turn`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.sessionToken}` }, body: JSON.stringify({ input: "user request" }) });
    assert.equal((await turn(other.session.id)).status, 401);
    const response = await turn(session.session.id);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).output, "verified-answer");
    const saved = await files.read("sessions", [tenant.id, ws.id, session.session.id]);
    assert.ok(saved);
    assert.ok(await files.read("workspace-memory", [tenant.id, ws.id]));
  } finally {
    await dp.close(); await cp.close();
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
