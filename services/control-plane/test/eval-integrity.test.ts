import assert from "node:assert/strict";
import { it } from "node:test";
import { MemoryStore } from "@diy-agent/db";
import { runGoldenTaskAgentEval, defaultSnapshotAwareGoldenTaskRunner } from "../src/golden-task-runner.js";

it("fails closed without a real executor instead of copying expected answers", () => {
  assert.throws(() => defaultSnapshotAwareGoldenTaskRunner({ expectedContains: ["secret-answer"] } as never,
    { systemPrompt: "secret-answer" } as never), /agent_runner_not_configured/);
});

it("scores each task against its own trace even when tasks have different answers", async () => {
  const store = new MemoryStore();
  const tenant = await store.createTenant({ name: "eval" });
  const ws = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const { profile, version } = (await store.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {} }))!;
  for (const answer of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
    await store.createGoldenTask({ profileId: profile.id, input: answer, expectedContains: [answer] });
  }
  const result = await runGoldenTaskAgentEval(store, { profileId: profile.id, profileVersionId: version.id, snapshot: profile,
    agentRunner: async task => { await new Promise(resolve => setTimeout(resolve, 5)); return { output: task.input, latencyMs: 10 }; } });
  assert.equal(result.passRate, 1);
});
