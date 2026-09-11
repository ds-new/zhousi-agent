import type { GovernanceTier, ProfileId } from "@diy-agent/domain";
import {
  evaluatePinGate,
  scoreProfileTask,
  validateGoldenTaskCount,
  type EvalTrace,
} from "@diy-agent/eval-harness";

export interface EvolutionRunRequest {
  profileId: ProfileId;
  baseVersionId: string;
  tier: GovernanceTier;
  target: "skill" | "prompt" | "mcp_description";
  snapshot?: unknown;
  evalTasks?: unknown[];
  traces?: unknown[];
}

export interface EvolutionRunResponse {
  runId: string;
  status: "running" | "completed" | "failed" | "awaiting_review";
  candidateVersionId?: string;
  evalScoreDelta?: number;
  requiresReview?: boolean;
  engine?: string;
  gepaRounds?: Array<{ round: number; passRate: number }>;
  gepaBestRound?: number;
  gepaBaselinePassRate?: number;
  gepaFinalPassRate?: number;
  mutations?: Array<{ path: string; before: string; after: string; tier: GovernanceTier }>;
}

const EVOLUTION_URL = process.env.DIY_EVOLUTION_URL ?? "http://127.0.0.1:9880";

export async function invokeEvolutionService(
  req: EvolutionRunRequest,
): Promise<EvolutionRunResponse> {
  const res = await fetch(`${EVOLUTION_URL}/run`, {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: { "Content-Type": "application/json", ...(process.env.DIY_EVOLUTION_INTERNAL_TOKEN ? { Authorization: `Bearer ${process.env.DIY_EVOLUTION_INTERNAL_TOKEN}` } : {}) },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`evolution_http_${res.status}`);
  }
  return (await res.json()) as EvolutionRunResponse;
}

export { evaluatePinGate, scoreProfileTask, validateGoldenTaskCount, type EvalTrace };
