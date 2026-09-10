import type { ControlPlaneStore } from "@diy-agent/db";
import type { EvolutionRun, TenantId } from "@diy-agent/domain";
import type { EvolutionClosureResult } from "./evolution-closure.js";
import type { FireWebhookFn } from "./profile-pin.js";

export async function emitEvolutionApproved(
  store: ControlPlaneStore,
  input: {
    tenantId: TenantId;
    run: EvolutionRun;
    reviewer: string;
    closure: EvolutionClosureResult | null;
    fireWebhooks: FireWebhookFn;
  },
): Promise<void> {
  const profile = await store.getProfile(input.run.profileId);
  await store.appendAudit({
    tenantId: input.tenantId,
    workspaceId: profile?.workspaceId,
    action: "evolution.approved",
    actor: input.reviewer,
    metadata: {
      runId: input.run.id,
      profileId: input.run.profileId,
      candidateVersionId: input.run.candidateVersionId,
      tier: input.run.tier,
      target: input.run.target,
      gepaRounds: input.run.gepaRounds,
      gepaFinalPassRate: input.run.gepaFinalPassRate,
      evalScoreDelta: input.run.evalScoreDelta,
      mutationCount: input.run.mutations?.length ?? 0,
      autoPinOk: input.closure?.pin.ok ?? false,
      postEvolutionPassRate: input.closure?.postEvolutionEval?.gate.passRate,
      postEvolutionPinGatePassed: input.closure?.postEvolutionEval?.gate.passed,
    },
  });

  await input.fireWebhooks(input.tenantId, "evolution.approved", {
    runId: input.run.id,
    profileId: input.run.profileId,
    candidateVersionId: input.run.candidateVersionId,
    tier: input.run.tier,
    target: input.run.target,
    reviewer: input.reviewer,
    mutations: input.run.mutations,
    gepaRounds: input.run.gepaRounds,
    gepaFinalPassRate: input.run.gepaFinalPassRate,
    evalScoreDelta: input.run.evalScoreDelta,
    autoPin: input.closure?.pin,
    postEvolutionEval: input.closure
      ? {
          passRate: input.closure.postEvolutionEval.gate.passRate,
          pinGatePassed: input.closure.postEvolutionEval.gate.passed,
        }
      : undefined,
  });
}
