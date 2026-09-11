import assert from "node:assert/strict";
import { it } from "node:test";
import { MemoryStore } from "@diy-agent/db";
import { evaluateMultiAgent } from "../src/multi-agent-eval.js";
import { runEvolutionCycle } from "../src/evolution-cycle.js";

it("evaluates real worker outputs and stores a separate collaboration evaluation", async () => {
  const store = new MemoryStore();
  const tenant = await store.createTenant({ name: "team" });
  const ws = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const worker = (await store.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {} }))!;
  const root = (await store.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: { orchestration: { topology: "pipeline", workerProfileIds: [worker.profile.id, worker.profile.id] } } }))!;
  for (let i = 0; i < 5; i++) await store.createGoldenTask({ profileId: root.profile.id, input: `task ${i}`, expectedContains: ["evidence"] });
  let calls = 0;
  const result = await evaluateMultiAgent(store, root.profile.id, task => {
    assert.equal(task.expectedContains, undefined);
    calls++;
    return { output: "evidence", latencyMs: 20, toolCalls: [{ name: "lookup", ok: true }] };
  });
  assert.equal(calls, 10);
  assert.equal(result.gate.passRate, 1);
  assert.equal(result.evalRun.scope, "multi_agent");
  assert.equal(result.collaboration[0]?.handoffCount, 2);
  const failed = await evaluateMultiAgent(store, root.profile.id, () => ({ output: "wrong answer", latencyMs: 10 }));
  assert.equal(failed.gate.passed, false);
});

it("scheduled cycles measure published profiles and do not mutate healthy profiles", async () => {
  const store = new MemoryStore();
  const tenant = await store.createTenant({ name: "scheduled" });
  const ws = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const { profile, version } = (await store.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {} }))!;
  await store.pinProfile(profile.id, version.id);
  for (let i = 0; i < 5; i++) await store.createGoldenTask({ profileId: profile.id, input: "task", expectedContains: ["evidence"] });
  const result = await runEvolutionCycle(store, () => ({ output: "evidence", latencyMs: 5 }), async () => { throw new Error("must not mutate a healthy profile"); }, async () => {});
  assert.deepEqual(result, [{ profileId: profile.id, status: "healthy" }]);
  assert.equal((await store.getProfile(profile.id))?.pinnedVersionId, version.id);
});
