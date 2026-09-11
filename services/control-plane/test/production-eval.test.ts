import assert from "node:assert/strict";
import { it } from "node:test";
import { MemoryStore } from "@diy-agent/db";
import { runProfileEvaluation } from "../src/profile-eval.js";
import { runGoldenTaskAgentEval } from "../src/golden-task-runner.js";
import { attemptPinProfileVersion } from "../src/profile-pin.js";

async function fixture() {
  const store = new MemoryStore();
  const tenant = await store.createTenant({ name: "evidence" });
  const workspace = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const { profile, version } = (await store.createProfile({ tenantId: tenant.id, workspaceId: workspace.id, profile: {} }))!;
  for (let i = 0; i < 5; i++) await store.createGoldenTask({ profileId: profile.id, input: `question ${i}`, expectedContains: ["answer"] });
  return { store, tenant, profile, version };
}

it("refuses unlinked manual traces as publication evidence", async () => {
  const { store, profile, version } = await fixture();
  for (let i = 0; i < 5; i++) await store.saveTrace({ profileId: profile.id, profileVersionId: version.id, output: "answer", latencyMs: 1 });
  assert.equal((await runProfileEvaluation(store, profile.id, version.id))!.gate.passed, false);
});

it("never exposes evaluator answers to agent executors", async () => {
  const { store, profile, version } = await fixture();
  const result = await runGoldenTaskAgentEval(store, { profileId: profile.id, profileVersionId: version.id, snapshot: version.snapshot,
    agentRunner: task => { assert.equal(task.expectedContains, undefined); return { output: "answer", latencyMs: 1 }; } });
  assert.equal(result.gate!.passed, true);
});

it("rejects cached passing gates after benchmark changes", async () => {
  const { store, tenant, profile, version } = await fixture();
  const result = await runGoldenTaskAgentEval(store, { profileId: profile.id, profileVersionId: version.id, snapshot: version.snapshot,
    agentRunner: () => ({ output: "answer", latencyMs: 1 }) });
  assert.equal(result.gate!.passed, true);
  await store.createGoldenTask({ profileId: profile.id, input: "new question", expectedContains: ["new answer"] });
  const pin = await attemptPinProfileVersion(store, { tenantId: tenant.id, profileId: profile.id, versionId: version.id,
    fireWebhooks: async () => {}, evaluation: result.evaluation! });
  assert.equal(pin.ok, false);
});

it("rejects invalid measured latency rather than passing NaN comparisons", async () => {
  const { store, profile, version } = await fixture();
  await assert.rejects(runGoldenTaskAgentEval(store, { profileId: profile.id, profileVersionId: version.id, snapshot: version.snapshot,
    agentRunner: () => ({ output: "answer", latencyMs: Number.NaN }) }), /invalid_agent_result/);
});

it("serializes profile evolution creation and makes finalized candidates immutable", async () => {
  const { store, tenant, profile } = await fixture();
  const runs = await Promise.all(Array.from({ length: 3 }, () => store.createEvolutionRun({ tenantId: tenant.id, profileId: profile.id, trigger: "manual", tier: "L1", target: "mcp_description" })));
  assert.equal(runs.filter(Boolean).length, 1);
  const run = runs.find(Boolean)!;
  const finalized = (await store.finalizeEvolutionFromService({ tenantId: tenant.id, runId: run.id, status: "completed" }))!;
  await store.finalizeEvolutionFromService({ tenantId: tenant.id, runId: run.id, status: "failed" });
  assert.equal((await store.getEvolutionRun(run.id))!.status, finalized.status);
});

it("does not reuse a complete older batch when the latest execution aborts", async () => {
  const { store, profile, version } = await fixture();
  await runGoldenTaskAgentEval(store, { profileId: profile.id, profileVersionId: version.id, snapshot: version.snapshot,
    agentRunner: () => ({ output: "answer", latencyMs: 1 }) });
  let calls = 0;
  await assert.rejects(runGoldenTaskAgentEval(store, { profileId: profile.id, profileVersionId: version.id, snapshot: version.snapshot,
    agentRunner: () => { if (++calls === 1) throw new Error("model unavailable"); return { output: "answer", latencyMs: 1 }; } }), /model unavailable/);
  assert.equal((await runProfileEvaluation(store, profile.id, version.id))!.gate.passed, false);
});

it("expires evidence after 24 hours", async () => {
  const { store, profile, version } = await fixture();
  await runGoldenTaskAgentEval(store, { profileId: profile.id, profileVersionId: version.id, snapshot: version.snapshot,
    agentRunner: () => ({ output: "answer", latencyMs: 1 }) });
  const read = store.listTraces.bind(store);
  store.listTraces = async (...args) => (await read(...args)).map(t => ({ ...t, createdAt: new Date(Date.now() - 25 * 3600_000) }));
  assert.equal((await runProfileEvaluation(store, profile.id, version.id))!.gate.passed, false);
});

import { executeEvolutionPipeline } from "../src/evolution-orchestrator.js";

it("rejects training-only improvement and keeps holdout data out of the optimizer", async () => {
  const { store, tenant, profile } = await fixture();
  for (let i = 0; i < 5; i++) await store.createGoldenTask({ profileId: profile.id, input: `private holdout ${i}`, expectedContains: ["secret holdout answer"], split: "holdout" });
  const run = (await store.createEvolutionRun({ tenantId: tenant.id, profileId: profile.id, trigger: "manual", target: "prompt", tier: "L2" }))!;
  const result = await executeEvolutionPipeline(store, run, tenant.id, async request => {
    assert.equal(JSON.stringify(request).includes("private holdout"), false);
    assert.equal(JSON.stringify(request).includes("secret holdout answer"), false);
    return { runId: "candidate", status: "completed", mutations: [{ path: "prompt/system", before: profile.systemPrompt, after: "trained", tier: "L2" }] };
  }, (task, snapshot) => ({ output: snapshot.systemPrompt === "trained" && !task.input.startsWith("private") ? "answer" : "wrong", latencyMs: 1 }));
  assert.equal(result!.run.status, "failed");
  assert.equal(result!.run.candidateVersionId, undefined);
});

it("accepts a candidate only after independently measured holdout improvement", async () => {
  const { store, tenant, profile } = await fixture();
  for (let i = 0; i < 5; i++) await store.createGoldenTask({ profileId: profile.id, input: `holdout ${i}`, expectedContains: ["answer"], split: "holdout" });
  const run = (await store.createEvolutionRun({ tenantId: tenant.id, profileId: profile.id, trigger: "manual", target: "prompt", tier: "L2" }))!;
  const result = await executeEvolutionPipeline(store, run, tenant.id, async () => ({ runId: "candidate", status: "completed",
    mutations: [{ path: "prompt/system", before: profile.systemPrompt, after: "generalizes", tier: "L2" }] }),
  (task, snapshot) => { assert.equal(task.expectedContains, undefined); return { output: snapshot.systemPrompt === "generalizes" ? "answer" : "wrong", latencyMs: 1 }; });
  assert.equal(result!.run.status, "awaiting_review");
  assert.equal(result!.run.evalScoreDelta, 1);
  assert.ok(result!.run.candidateVersionId);
});

it("marks failed executors terminal so later evolution is possible", async () => {
  const { store, tenant, profile } = await fixture();
  for (let i = 0; i < 5; i++) await store.createGoldenTask({ profileId: profile.id, input: `holdout ${i}`, expectedContains: ["answer"], split: "holdout" });
  const run = (await store.createEvolutionRun({ tenantId: tenant.id, profileId: profile.id, trigger: "manual", target: "prompt", tier: "L2" }))!;
  await assert.rejects(executeEvolutionPipeline(store, run, tenant.id, async () => { throw new Error("must not reach optimizer"); }, () => { throw new Error("executor_failed"); }), /executor_failed/);
  assert.equal((await store.getEvolutionRun(run.id))!.status, "failed");
  assert.ok(await store.createEvolutionRun({ tenantId: tenant.id, profileId: profile.id, trigger: "manual", target: "prompt", tier: "L2" }));
});

it("cannot approve a candidate before the optimizer has finalized its actual mutations", async () => {
  const { store, tenant, profile } = await fixture();
  const run = (await store.createEvolutionRun({ tenantId: tenant.id, profileId: profile.id, trigger: "manual", target: "prompt", tier: "L2" }))!;
  assert.equal(await store.approveEvolutionRun({ tenantId: tenant.id, runId: run.id, reviewer: "admin" }), null);
});

it("atomically refuses pinning if the benchmark changes after the gate is read", async () => {
  const { store, tenant, profile, version } = await fixture();
  await runGoldenTaskAgentEval(store, { profileId: profile.id, profileVersionId: version.id, snapshot: version.snapshot,
    agentRunner: () => ({ output: "answer", latencyMs: 1 }) });
  const pin = store.pinProfile.bind(store);
  store.pinProfile = async (...args) => {
    await store.createGoldenTask({ profileId: profile.id, input: "racing benchmark update", expectedContains: ["another answer"] });
    return pin(...args);
  };
  assert.equal((await attemptPinProfileVersion(store, { tenantId: tenant.id, profileId: profile.id, versionId: version.id, fireWebhooks: async () => {} })).ok, false);
});

it("allows rejecting an interrupted running job and ignores its late completion", async () => {
  const { store, tenant, profile } = await fixture();
  const run = (await store.createEvolutionRun({ tenantId: tenant.id, profileId: profile.id, trigger: "manual", target: "mcp_description", tier: "L1" }))!;
  const rejected = await store.rejectEvolutionRun({ tenantId: tenant.id, runId: run.id, reviewer: "operator", reason: "executor process lost" });
  assert.equal(rejected?.status, "rejected");
  const late = await store.finalizeEvolutionFromService({ tenantId: tenant.id, runId: run.id, status: "completed" });
  assert.equal(late?.status, "rejected");
  assert.equal(late?.candidateVersionId, undefined);
  assert.ok(await store.createEvolutionRun({ tenantId: tenant.id, profileId: profile.id, trigger: "manual", target: "mcp_description", tier: "L1" }));
});
