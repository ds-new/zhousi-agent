import type { AgentProfile, EvalTask, ProfileId, ProfileVersionId } from "@diy-agent/domain";
import type { ControlPlaneStore } from "@diy-agent/db";
import { evaluationTasks, taskSetHash, EVALUATION_STARTED_TASK_ID, type EvaluationScope, runProfileEvaluation } from "./profile-eval.js";

let lastBatchTime = 0;

export interface GoldenTaskRunResult {
  output: string;
  latencyMs: number;
  toolCalls?: Array<{ name: string; ok: boolean }>;
  tokensUsed?: number;
}

export type AgentGoldenTaskRunner = (
  task: EvalTask,
  snapshot: AgentProfile,
) => GoldenTaskRunResult | Promise<GoldenTaskRunResult>;

/** No production fallback: evaluation requires an actual agent executor. */
export function defaultSnapshotAwareGoldenTaskRunner(_task: EvalTask, _snapshot: AgentProfile): GoldenTaskRunResult {
  throw new Error("agent_runner_not_configured");
}

export async function runGoldenTaskAgentEval(
  store: ControlPlaneStore,
  input: {
    profileId: ProfileId;
    profileVersionId: ProfileVersionId;
    snapshot: AgentProfile;
    agentRunner?: AgentGoldenTaskRunner;
    scope?: EvaluationScope;
  },
) {
  const runner = input.agentRunner ?? defaultSnapshotAwareGoldenTaskRunner;
  const scope = input.scope ?? "profile";
  const tasks = evaluationTasks(await store.listGoldenTasks(input.profileId), scope);
  if (tasks.length < 5 || tasks.length > 100) throw new Error("requires_5_to_100_golden_tasks");
  const hash = taskSetHash(tasks, input.snapshot);
  lastBatchTime = Math.max(lastBatchTime + 1, Math.floor((performance.timeOrigin + performance.now()) * 1000));
  const evalBatchId = `${lastBatchTime}-${crypto.randomUUID()}`;
  // Persist invalidation before executing the first task: even a zero-output failure supersedes old success.
  await store.saveTrace({ profileId: input.profileId, profileVersionId: input.profileVersionId,
    taskId: EVALUATION_STARTED_TASK_ID, evalBatchId, taskSetHash: hash,
    executionSource: "agent_runner", evalScope: scope, output: "", latencyMs: 0 });
  for (const task of tasks) {
    const result = await runner({ id: task.id, profileId: task.profileId, input: task.input }, structuredClone(input.snapshot));
    validateAgentResult(result);
    await store.saveTrace({
      taskSetHash: hash, executionSource: "agent_runner", evalScope: scope,
      taskId: task.id,
      evalBatchId,
      profileId: input.profileId,
      profileVersionId: input.profileVersionId,
      output: result.output,
      latencyMs: result.latencyMs,
      toolCalls: result.toolCalls,
      tokensUsed: result.tokensUsed,
    });
  }
  const evaluation = await runProfileEvaluation(
    store,
    input.profileId,
    input.profileVersionId,
    evalBatchId,
    { scope, snapshot: input.snapshot },
  );
  return {
    passRate: evaluation?.gate.passRate ?? 0,
    gate: evaluation?.gate,
    evaluation,
  };
}

export function validateAgentResult(result: GoldenTaskRunResult): void {
  if (!result || typeof result.output !== "string" || !Number.isFinite(result.latencyMs) || result.latencyMs < 0 ||
    (result.tokensUsed !== undefined && (!Number.isSafeInteger(result.tokensUsed) || result.tokensUsed < 0)) ||
    (result.toolCalls !== undefined && (!Array.isArray(result.toolCalls) || result.toolCalls.some(t => !t || typeof t.name !== "string" || typeof t.ok !== "boolean")))) {
    throw new Error("invalid_agent_result");
  }
}
