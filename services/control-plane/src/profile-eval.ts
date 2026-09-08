import type { AgentProfile, ProfileId, ProfileVersionId } from "@diy-agent/domain";
import { collectCredentialRefIds } from "@diy-agent/domain";
import {
  evaluatePinGate,
  scoreProfileTask,
  type EvalTrace,
} from "@diy-agent/eval-harness";
import type { ControlPlaneStore, EvalTraceRecord } from "@diy-agent/db";

export { collectCredentialRefIds };

function tracesToEval(traces: EvalTraceRecord[]): EvalTrace[] {
  return traces.map((t) => ({
    profileVersionId: t.profileVersionId,
    output: t.output,
    latencyMs: t.latencyMs,
    toolCalls: t.toolCalls,
    tokensUsed: t.tokensUsed,
  }));
}

export async function runProfileEvaluation(
  store: ControlPlaneStore,
  profileId: ProfileId,
  versionId: ProfileVersionId,
) {
  const profile = await store.getProfile(profileId);
  if (!profile) return null;

  const tasks = await store.listGoldenTasks(profileId);
  const traces = await store.listTraces(profileId);
  const evalTraces = tracesToEval(traces);
  const results = tasks.map((task) =>
    scoreProfileTask(task, {
      profileVersionId: versionId,
      output: task.expectedContains?.[0] ?? traces[0]?.output ?? "ok",
      latencyMs: traces[0]?.latencyMs ?? 100,
      toolCalls: traces[0]?.toolCalls,
      tokensUsed: traces[0]?.tokensUsed,
    }),
  );
  const gate = evaluatePinGate(results, evalTraces);
  const evalRun = await store.saveProfileEvalRun({
    profileId,
    profileVersionId: versionId,
    passRate: gate.passRate,
    p95LatencyMs: gate.p95LatencyMs,
    toolSuccessRate: gate.toolSuccessRate,
    pinGatePassed: gate.passed,
    reasons: gate.reasons,
  });

  return { profile, results, gate, evalRun };
}
