import {
  DEFAULT_PROFILE_PIN_GATE,
  MIN_GOLDEN_TASKS_FOR_PIN,
  type EvalResult,
  type EvalTask,
  type ProfilePinGate,
  type ProfileVersionId,
} from "@diy-agent/domain";

export interface EvalTrace {
  profileVersionId: ProfileVersionId | string;
  output: string;
  latencyMs: number;
  toolCalls?: Array<{ name: string; ok: boolean }>;
  tokensUsed?: number;
}

export interface MultiAgentEvalTrace extends EvalTrace {
  agentIds: string[];
  handoffs: Array<{ from: string; to: string; latencyMs: number }>;
}

export function scoreProfileTask(task: EvalTask, trace: EvalTrace): EvalResult {
  let score = 0;
  const output = trace.output.toLowerCase();
  if (task.expectedContains?.length) {
    const hits = task.expectedContains.filter((s) => output.includes(s.toLowerCase()));
    score = hits.length / task.expectedContains.length;
  } else {
    score = trace.output.length > 0 ? 1 : 0;
  }
  const latencyOk = !task.maxLatencyMs || trace.latencyMs <= task.maxLatencyMs;
  return {
    taskId: task.id,
    profileVersionId: trace.profileVersionId as ProfileVersionId,
    score,
    latencyMs: trace.latencyMs,
    passed: score >= 0.8 && latencyOk,
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

export function evaluatePinGate(
  results: EvalResult[],
  traces: EvalTrace[],
  gate: ProfilePinGate = DEFAULT_PROFILE_PIN_GATE,
) {
  const reasons: string[] = [];
  if (!results.length || traces.length !== results.length) reasons.push("incomplete_results");
  if (traces.some(t => !Number.isFinite(t.latencyMs) || t.latencyMs < 0 ||
    (t.tokensUsed !== undefined && (!Number.isSafeInteger(t.tokensUsed) || t.tokensUsed < 0))) ||
    results.some(r => !Number.isFinite(r.score) || r.score < 0 || r.score > 1)) reasons.push("invalid_measurements");
  const passRate =
    results.length === 0 ? 0 : results.filter((r) => r.passed).length / results.length;
  const latencies = traces.map((t) => t.latencyMs);
  const p95LatencyMs = percentile(latencies, 95);
  const toolCalls = traces.flatMap((t) => t.toolCalls ?? []);
  const toolSuccessRate =
    toolCalls.length === 0
      ? 1
      : toolCalls.filter((t) => t.ok).length / toolCalls.length;
  const maxTokens = Math.max(...traces.map((t) => t.tokensUsed ?? 0), 0);

  if (passRate < gate.minPassRate) {
    reasons.push(`pass_rate ${passRate.toFixed(2)} < ${gate.minPassRate}`);
  }
  if (p95LatencyMs > gate.maxP95LatencyMs) {
    reasons.push(`p95_latency ${p95LatencyMs}ms > ${gate.maxP95LatencyMs}ms`);
  }
  if (gate.minToolSuccessRate !== undefined && toolSuccessRate < gate.minToolSuccessRate) {
    reasons.push(`tool_success ${toolSuccessRate.toFixed(2)} < ${gate.minToolSuccessRate}`);
  }
  if (gate.maxTokensPerRun !== undefined && maxTokens > gate.maxTokensPerRun) {
    reasons.push(`tokens ${maxTokens} > ${gate.maxTokensPerRun}`);
  }

  return {
    passed: reasons.length === 0,
    passRate,
    p95LatencyMs,
    toolSuccessRate,
    reasons,
  };
}

export function validateGoldenTaskCount(count: number): { ok: boolean; reason?: string } {
  if (count > 100) return { ok: false, reason: "requires_at_most_100_golden_tasks" };
  if (count < MIN_GOLDEN_TASKS_FOR_PIN) {
    return {
      ok: false,
      reason: `requires_at_least_${MIN_GOLDEN_TASKS_FOR_PIN}_golden_tasks`,
    };
  }
  return { ok: true };
}

export function scoreMultiAgentRun(trace: MultiAgentEvalTrace) {
  const handoffCount = trace.handoffs.length;
  const avgHandoffLatencyMs =
    handoffCount === 0
      ? 0
      : trace.handoffs.reduce((s, h) => s + h.latencyMs, 0) / handoffCount;
  const agentParticipation: Record<string, number> = {};
  for (const id of trace.agentIds) {
    agentParticipation[id] = (agentParticipation[id] ?? 0) + 1;
  }
  const toolSuccessRate =
    trace.toolCalls && trace.toolCalls.length > 0
      ? trace.toolCalls.filter((t) => t.ok).length / trace.toolCalls.length
      : 1;
  const collaborationScore =
    handoffCount > 0
      ? Math.min(1, toolSuccessRate * (1 / Math.max(1, avgHandoffLatencyMs / 1000)))
      : toolSuccessRate;
  return { handoffCount, avgHandoffLatencyMs, agentParticipation, collaborationScore };
}

export function aggregateResults(results: EvalResult[]) {
  if (results.length === 0) {
    return { passRate: 0, avgScore: 0, avgLatencyMs: 0 };
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    passRate: passed / results.length,
    avgScore: results.reduce((s, r) => s + r.score, 0) / results.length,
    avgLatencyMs: results.reduce((s, r) => s + r.latencyMs, 0) / results.length,
  };
}
