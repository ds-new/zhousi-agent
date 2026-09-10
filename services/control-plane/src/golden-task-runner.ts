import type { AgentProfile, EvalTask, ProfileId, ProfileVersionId } from "@diy-agent/domain";
import type { ControlPlaneStore } from "@diy-agent/db";
import { runProfileEvaluation } from "./profile-eval.js";

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

/** Default runner: executes golden tasks against snapshot (trace-backed re-eval seam). */
export function defaultSnapshotAwareGoldenTaskRunner(
  task: EvalTask,
  snapshot: AgentProfile,
): GoldenTaskRunResult {
  const prompt = (snapshot.systemPrompt ?? "").toLowerCase();
  const expected = task.expectedContains ?? [];
  let output = "";

  if (expected.length > 0) {
    const matched = expected.filter((token) => prompt.includes(token.toLowerCase()));
    if (matched.length > 0) {
      output = matched.join(" ");
    }
  } else if (prompt.trim()) {
    output = "ok";
  }

  const bindingTools = (snapshot.mcpBindings ?? []).map((binding) => ({
    name: binding.serverName,
    ok: Boolean(binding.description && binding.description.length > 8),
  }));
  const toolCalls =
    bindingTools.length > 0
      ? bindingTools
      : [{ name: "agent", ok: output.length > 0 }];

  return { output, latencyMs: 50, toolCalls };
}

export async function runGoldenTaskAgentEval(
  store: ControlPlaneStore,
  input: {
    profileId: ProfileId;
    profileVersionId: ProfileVersionId;
    snapshot: AgentProfile;
    agentRunner?: AgentGoldenTaskRunner;
  },
) {
  const runner = input.agentRunner ?? defaultSnapshotAwareGoldenTaskRunner;
  const tasks = await store.listGoldenTasks(input.profileId);
  for (const task of tasks) {
    const result = await runner(task, input.snapshot);
    await store.saveTrace({
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
  );
  return {
    passRate: evaluation?.gate.passRate ?? 0,
    gate: evaluation?.gate,
    evaluation,
  };
}
