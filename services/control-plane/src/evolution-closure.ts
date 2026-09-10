import type { ControlPlaneStore } from "@diy-agent/db";
import type { EvolutionRun, ProfileId, ProfileVersionId, TenantId } from "@diy-agent/domain";
import {
  type AgentGoldenTaskRunner,
  defaultSnapshotAwareGoldenTaskRunner,
  runGoldenTaskAgentEval,
} from "./golden-task-runner.js";
import { runProfileEvaluation } from "./profile-eval.js";
import { attemptPinProfileVersion, type FireWebhookFn, type PinProfileResult } from "./profile-pin.js";

export interface EvolutionClosureResult {
  postEvolutionEval: NonNullable<Awaited<ReturnType<typeof runProfileEvaluation>>>;
  pin: PinProfileResult;
}

async function ensureCandidateTraces(
  store: ControlPlaneStore,
  input: {
    profileId: ProfileId;
    candidateVersionId: ProfileVersionId;
    agentRunner: AgentGoldenTaskRunner;
  },
): Promise<void> {
  const candidateVersion = await store.getProfileVersion(
    input.profileId,
    input.candidateVersionId,
  );
  if (!candidateVersion) return;

  const existing = (await store.listTraces(input.profileId)).filter(
    (trace) => trace.profileVersionId === input.candidateVersionId,
  );
  const tasks = await store.listGoldenTasks(input.profileId);
  if (existing.length >= tasks.length) return;

  await runGoldenTaskAgentEval(store, {
    profileId: input.profileId,
    profileVersionId: input.candidateVersionId,
    snapshot: candidateVersion.snapshot,
    agentRunner: input.agentRunner,
  });
}

export async function tryAutoPinAfterEvolution(
  store: ControlPlaneStore,
  input: {
    profileId: ProfileId;
    tenantId: TenantId;
    evolutionRun: EvolutionRun;
    fireWebhooks: FireWebhookFn;
    agentRunner?: AgentGoldenTaskRunner;
  },
): Promise<EvolutionClosureResult | null> {
  if (input.evolutionRun.status !== "completed") return null;
  if (!input.evolutionRun.candidateVersionId) return null;

  const runner = input.agentRunner ?? defaultSnapshotAwareGoldenTaskRunner;
  await ensureCandidateTraces(store, {
    profileId: input.profileId,
    candidateVersionId: input.evolutionRun.candidateVersionId,
    agentRunner: runner,
  });

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
