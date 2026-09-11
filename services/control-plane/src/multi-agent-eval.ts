import type { ControlPlaneStore } from "@diy-agent/db";
import type { AgentProfile, ProfileId, ProfileVersionId } from "@diy-agent/domain";
import { createOrchestrator } from "@diy-agent/orchestrator";
import { evaluatePinGate, scoreProfileTask, scoreMultiAgentRun, type MultiAgentEvalTrace } from "@diy-agent/eval-harness";
import type { AgentGoldenTaskRunner } from "./golden-task-runner.js";
import { validateAgentResult } from "./golden-task-runner.js";
import { taskSetHash, EVALUATION_MAX_AGE_MS } from "./profile-eval.js";

export async function evaluateMultiAgent(store: ControlPlaneStore, profileId: ProfileId, runner: AgentGoldenTaskRunner) {
  const root = await store.getProfile(profileId);
  const version = root?.pinnedVersionId ? await store.getProfileVersion(profileId, root.pinnedVersionId) : await store.getLatestProfileVersion(profileId);
  if (!root || !version) throw new Error("profile_not_found");
  const config = version.snapshot.orchestration ?? { topology: "supervisor" as const };
  const snapshots = new Map<string, AgentProfile>();
  const workerVersionIds: Record<string, ProfileVersionId> = {};
  for (const id of config.workerProfileIds?.length ? config.workerProfileIds : [profileId]) {
    const worker = await store.getProfile(id);
    if (!worker || worker.workspaceId !== root.workspaceId) throw new Error("worker_workspace_mismatch");
    const selected = worker.pinnedVersionId ? await store.getProfileVersion(id, worker.pinnedVersionId) : await store.getLatestProfileVersion(id);
    if (!selected) throw new Error("worker_version_not_found");
    snapshots.set(id, selected.snapshot);
    workerVersionIds[id] = selected.id;
  }
  const tasks = await store.listGoldenTasks(profileId);
  if (tasks.length < 5 || tasks.length > 100) throw new Error("requires_5_to_100_golden_tasks");
  const traces: MultiAgentEvalTrace[] = [];
  const results = [];
  for (const task of tasks) {
    const tools: Array<{ name: string; ok: boolean }> = [];
    let tokensUsed = 0;
    const orchestrator = createOrchestrator(config.topology, async (work, context) => {
      const result = await runner({ id: crypto.randomUUID(), profileId: work.workerProfileId as ProfileId,
        input: work.instruction + (context ? `\n\nPrior evidence:\n${context}` : "") }, snapshots.get(work.workerProfileId)!);
      validateAgentResult(result);
      tools.push(...(result.toolCalls ?? [])); tokensUsed += result.tokensUsed ?? 0;
      return result.output;
    });
    const start = performance.now();
    const run = await orchestrator.execute(orchestrator.plan(task.input, config, profileId));
    const trace: MultiAgentEvalTrace = { profileVersionId: version.id, output: run.finalOutput, latencyMs: performance.now() - start,
      toolCalls: tools, tokensUsed, handoffs: run.handoffs, agentIds: run.plan.tasks.filter(t => t.status === "done").map(t => t.workerProfileId) };
    traces.push(trace); results.push(scoreProfileTask(task, trace));
  }
  const gate = evaluatePinGate(results, traces);
  if (tasks.some(task => !task.expectedContains?.length || task.expectedContains.some(answer => !answer.trim()))) {
    gate.reasons.push("task_assertions_required"); gate.passed = false;
  }
  const evalRun = await store.saveProfileEvalRun({ profileId, profileVersionId: version.id, scope: "multi_agent", passRate: gate.passRate,
    taskResults: results, workerVersionIds, evalBatchId: crypto.randomUUID(), taskSetHash: taskSetHash(tasks, version.snapshot),
    evidenceExpiresAt: new Date(Date.now() + EVALUATION_MAX_AGE_MS),
    p95LatencyMs: gate.p95LatencyMs, toolSuccessRate: gate.toolSuccessRate, pinGatePassed: gate.passed, reasons: gate.reasons });
  return { evalRun, gate, results, collaboration: traces.map(scoreMultiAgentRun) };
}
