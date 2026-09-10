import type { ProfileId, ProfileVersionId } from "@diy-agent/domain";
import {
  evaluatePinGate,
  scoreProfileTask,
  type EvalTrace,
} from "@diy-agent/eval-harness";
import type { ControlPlaneStore, EvalTraceRecord } from "@diy-agent/db";

function tracesToEval(traces: EvalTraceRecord[]): EvalTrace[] {
  return traces.map((t) => ({
    profileVersionId: t.profileVersionId,
    output: t.output,
    latencyMs: t.latencyMs,
    toolCalls: t.toolCalls,
    tokensUsed: t.tokensUsed,
  }));
}

function traceForTask(
  versionId: ProfileVersionId,
  trace: EvalTraceRecord | undefined,
): EvalTrace {
  if (trace) {
    return {
      profileVersionId: versionId,
      output: trace.output,
      latencyMs: trace.latencyMs,
      toolCalls: trace.toolCalls,
      tokensUsed: trace.tokensUsed,
    };
  }
  return {
    profileVersionId: versionId,
    output: "",
    latencyMs: Number.MAX_SAFE_INTEGER,
    toolCalls: [],
  };
}

export async function runProfileEvaluation(
  store: ControlPlaneStore,
  profileId: ProfileId,
  versionId: ProfileVersionId,
) {
  const profile = await store.getProfile(profileId);
  if (!profile) return null;

  const tasks = await store.listGoldenTasks(profileId);
  const allTraces = await store.listTraces(profileId);
  const versionTraces = allTraces.filter((t) => t.profileVersionId === versionId);
  const evalTraces = tracesToEval(versionTraces);
  const results = tasks.map((task, index) =>
    scoreProfileTask(task, traceForTask(versionId, versionTraces[index])),
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
