import { createHash } from "node:crypto";
import type { AgentProfile, EvalTask, ProfileId, ProfileVersionId } from "@diy-agent/domain";
import { evaluatePinGate, scoreProfileTask, validateGoldenTaskCount } from "@diy-agent/eval-harness";
import type { ControlPlaneStore } from "@diy-agent/db";

export type EvaluationScope = "profile" | "training" | "holdout";
export const EVALUATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const EVALUATION_STARTED_TASK_ID = "__evaluation_started__";
export function evaluationTasks(tasks: EvalTask[], scope: EvaluationScope): EvalTask[] {
  return tasks.filter(task => scope === "profile" || (scope === "holdout" ? task.split === "holdout" : task.split !== "holdout"));
}
export function taskSetHash(tasks: EvalTask[], snapshot: AgentProfile): string {
  return createHash("sha256").update(JSON.stringify({
    tasks: [...tasks].sort((a, b) => a.id.localeCompare(b.id)), snapshot,
  })).digest("hex");
}

/** Only one complete, fresh executor batch bound to the exact current benchmark is publishable. */
export async function runProfileEvaluation(
  store: ControlPlaneStore, profileId: ProfileId, versionId: ProfileVersionId, evalBatchId?: string,
  options: { scope?: EvaluationScope; snapshot?: AgentProfile } = {},
) {
  const profile = await store.getProfile(profileId);
  if (!profile) return null;
  const scope = options.scope ?? "profile";
  const version = await store.getProfileVersion(profileId, versionId);
  const snapshot = options.snapshot ?? version?.snapshot;
  const tasks = evaluationTasks(await store.listGoldenTasks(profileId), scope);
  const candidates = (await store.listTraces(profileId, 10000)).filter(t => t.profileVersionId === versionId && t.evalScope === scope);
  const batch = evalBatchId ?? [...candidates].sort((a, b) => (b.evalBatchId ?? "").localeCompare(a.evalBatchId ?? ""))[0]?.evalBatchId;
  const traces = batch ? candidates.filter(t => t.evalBatchId === batch && t.taskId !== EVALUATION_STARTED_TASK_ID) : [];
  const byTask = new Map(traces.map(t => [t.taskId, t]));
  const hash = snapshot ? taskSetHash(tasks, snapshot) : undefined;
  const results = tasks.map(task => scoreProfileTask(task, byTask.get(task.id) ?? {
    profileVersionId: versionId, output: "", latencyMs: Number.MAX_SAFE_INTEGER,
  }));
  const gate = evaluatePinGate(results, traces);
  const reasons: string[] = [];
  const count = validateGoldenTaskCount(tasks.length);
  if (!count.ok) reasons.push(count.reason!);
  if (!batch || traces.length !== tasks.length || byTask.size !== tasks.length || tasks.some(task => !byTask.has(task.id))) reasons.push("incomplete_execution_batch");
  if (!hash || traces.some(t => t.taskSetHash !== hash || t.executionSource !== "agent_runner")) reasons.push("benchmark_or_snapshot_mismatch");
  const now = Date.now();
  if (traces.some(t => !Number.isFinite(t.createdAt.getTime()) || now - t.createdAt.getTime() > EVALUATION_MAX_AGE_MS || t.createdAt.getTime() > now + 1000)) reasons.push("evaluation_evidence_expired");
  if (tasks.some(task => !task.expectedContains?.length || task.expectedContains.some(answer => !answer.trim()))) reasons.push("task_assertions_required");
  gate.reasons.push(...reasons);
  gate.passed = gate.reasons.length === 0;
  const evidenceExpiresAt = new Date(Math.min(...traces.map(t => t.createdAt.getTime()), now) + EVALUATION_MAX_AGE_MS);
  const evalRun = await store.saveProfileEvalRun({
    profileId, profileVersionId: versionId, scope: "profile", evalBatchId: batch, taskSetHash: hash, evidenceExpiresAt, taskResults: results,
    passRate: gate.passRate, p95LatencyMs: gate.p95LatencyMs, toolSuccessRate: gate.toolSuccessRate,
    pinGatePassed: gate.passed, reasons: gate.reasons,
  });
  return { profile, results, gate, evalRun };
}
