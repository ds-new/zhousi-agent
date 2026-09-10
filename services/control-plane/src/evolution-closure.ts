import type { ControlPlaneStore } from "@diy-agent/db";
import type { EvolutionRun, ProfileId, TenantId } from "@diy-agent/domain";
import { runProfileEvaluation } from "./profile-eval.js";
import { attemptPinProfileVersion, type FireWebhookFn, type PinProfileResult } from "./profile-pin.js";

export interface EvolutionClosureResult {
  postEvolutionEval: NonNullable<Awaited<ReturnType<typeof runProfileEvaluation>>>;
  pin: PinProfileResult;
}

export async function tryAutoPinAfterEvolution(
  store: ControlPlaneStore,
  input: {
    profileId: ProfileId;
    tenantId: TenantId;
    evolutionRun: EvolutionRun;
    fireWebhooks: FireWebhookFn;
  },
): Promise<EvolutionClosureResult | null> {
  if (input.evolutionRun.status !== "completed") return null;
  if (!input.evolutionRun.candidateVersionId) return null;
  if (input.evolutionRun.tier === "L2") return null;

  const postEvolutionEval = await runProfileEvaluation(
    store,
    input.profileId,
    input.evolutionRun.candidateVersionId,
  );
  if (!postEvolutionEval) return null;

  const pin = await attemptPinProfileVersion(store, {
    profileId: input.profileId,
    versionId: input.evolutionRun.candidateVersionId,
    tenantId: input.tenantId,
    fireWebhooks: input.fireWebhooks,
    skipWebhookOnPinGateFailure: true,
    evaluation: postEvolutionEval,
  });

  return { postEvolutionEval, pin };
}
