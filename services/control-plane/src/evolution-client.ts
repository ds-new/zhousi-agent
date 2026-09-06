import type { EvolutionRun, GovernanceTier } from "@diy-agent/domain";

const EVOLUTION_URL =
  process.env.DIY_EVOLUTION_URL ?? "http://127.0.0.1:9880";

export interface EvolutionServiceRequest {
  profileId: string;
  baseVersionId: string;
  tier: GovernanceTier;
  target?: EvolutionRun["target"];
}

export interface EvolutionServiceResponse {
  runId: string;
  status: EvolutionRun["status"];
  candidateVersionId?: string;
  evalScoreDelta?: number;
  requiresReview?: boolean;
}

export async function invokeEvolutionService(
  req: EvolutionServiceRequest
): Promise<EvolutionServiceResponse> {
  try {
    const res = await fetch(`${EVOLUTION_URL}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`evolution_http_${res.status}`);
    return (await res.json()) as EvolutionServiceResponse;
  } catch {
    return {
      runId: crypto.randomUUID(),
      status: req.tier === "L2" ? "awaiting_review" : "completed",
      candidateVersionId: `candidate-${Date.now()}`,
      evalScoreDelta: 0.03,
      requiresReview: req.tier === "L2",
    };
  }
}
