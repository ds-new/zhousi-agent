import type { ControlPlaneStore } from "@diy-agent/db";
import type { EvolutionRun, ProfileVersionId, TenantId } from "@diy-agent/domain";
import type { GovernanceTier, ProfileId } from "@diy-agent/domain";
import type { EvolutionRunRequest, EvolutionRunResponse } from "./evolution-client.js";

export type EvolutionInvoker = (req: EvolutionRunRequest) => Promise<EvolutionRunResponse>;

export interface EvolutionPipelineResult {
  run: EvolutionRun;
  awaitingReview: boolean;
}

export async function executeEvolutionPipeline(
  store: ControlPlaneStore,
  run: EvolutionRun,
  tenantId: TenantId,
  evolve: EvolutionInvoker,
): Promise<EvolutionPipelineResult | null> {
  const version = await store.getProfileVersion(run.profileId, run.baseVersionId);
  const traces = await store.listTraces(run.profileId, 50);
  const goldenTasks = await store.listGoldenTasks(run.profileId);

  let svc: EvolutionRunResponse;
  try {
    svc = await evolve({
      profileId: run.profileId,
      baseVersionId: run.baseVersionId,
      tier: run.tier,
      target: run.target,
      snapshot: version?.snapshot,
      evalTasks: goldenTasks,
      traces,
    });
  } catch {
    await store.finalizeEvolutionFromService({
      runId: run.id,
      tenantId,
      status: "failed",
    });
    throw new Error("evolution_service_unavailable");
  }

  const finalized = await store.finalizeEvolutionFromService({
    runId: run.id,
    tenantId,
    candidateVersionId: svc.candidateVersionId as ProfileVersionId | undefined,
    status:
      svc.requiresReview || svc.status === "awaiting_review"
        ? "awaiting_review"
        : svc.status === "failed"
          ? "failed"
          : run.tier === "L2"
            ? "awaiting_review"
            : "completed",
    evalScoreDelta: svc.evalScoreDelta,
    gepaRounds: svc.gepaRounds,
    gepaBestRound: svc.gepaBestRound,
    gepaBaselinePassRate: svc.gepaBaselinePassRate,
    gepaFinalPassRate: svc.gepaFinalPassRate,
    mutations: svc.mutations,
  });

  if (!finalized) return null;
  return {
    run: finalized,
    awaitingReview: finalized.status === "awaiting_review",
  };
}
