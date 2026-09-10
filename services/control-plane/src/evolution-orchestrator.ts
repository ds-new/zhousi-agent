import type { ControlPlaneStore } from "@diy-agent/db";
import {
  applyEvolutionMutations,
  type AgentProfile,
  type EvolutionMutation,
  type EvolutionRun,
  type ProfileVersionId,
  type TenantId,
} from "@diy-agent/domain";
import type { EvolutionRunRequest, EvolutionRunResponse } from "./evolution-client.js";
import {
  type AgentGoldenTaskRunner,
  defaultSnapshotAwareGoldenTaskRunner,
  runGoldenTaskAgentEval,
} from "./golden-task-runner.js";
import { runProfileEvaluation } from "./profile-eval.js";

export type EvolutionInvoker = (req: EvolutionRunRequest) => Promise<EvolutionRunResponse>;

export interface EvolutionPipelineResult {
  run: EvolutionRun;
  awaitingReview: boolean;
}

const GEPA_MAX_ROUNDS = Number(process.env.DIY_GEPA_MAX_ROUNDS ?? 3);
const GEPA_MIN_PASS_RATE = Number(process.env.DIY_GEPA_MIN_PASS_RATE ?? 0.85);

async function finalizeFromService(
  store: ControlPlaneStore,
  run: EvolutionRun,
  tenantId: TenantId,
  svc: EvolutionRunResponse,
  gepa: {
    rounds: Array<{ round: number; passRate: number }>;
    bestRound: number;
    baselinePassRate: number;
    finalPassRate: number;
    mutations?: EvolutionMutation[];
  },
): Promise<EvolutionPipelineResult | null> {
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
    evalScoreDelta: gepa.finalPassRate - gepa.baselinePassRate,
    gepaRounds: gepa.rounds,
    gepaBestRound: gepa.bestRound,
    gepaBaselinePassRate: gepa.baselinePassRate,
    gepaFinalPassRate: gepa.finalPassRate,
    mutations: gepa.mutations ?? svc.mutations,
  });
  if (!finalized) return null;
  return {
    run: finalized,
    awaitingReview: finalized.status === "awaiting_review",
  };
}

async function executeGepaEvolutionPipeline(
  store: ControlPlaneStore,
  run: EvolutionRun,
  tenantId: TenantId,
  evolve: EvolutionInvoker,
  agentRunner: AgentGoldenTaskRunner,
): Promise<EvolutionPipelineResult | null> {
  const version = await store.getProfileVersion(run.profileId, run.baseVersionId);
  if (!version) return null;

  const goldenTasks = await store.listGoldenTasks(run.profileId);
  const baselineEval = await runProfileEvaluation(store, run.profileId, run.baseVersionId);
  const baselinePassRate = baselineEval?.gate.passRate ?? 0;
  const rounds: Array<{ round: number; passRate: number }> = [
    { round: 0, passRate: baselinePassRate },
  ];

  let workingSnapshot = structuredClone(version.snapshot) as AgentProfile;
  let bestPassRate = baselinePassRate;
  let bestRound = 0;
  let bestMutations: EvolutionMutation[] = [];
  let lastSvc: EvolutionRunResponse | null = null;

  for (let round = 1; round <= GEPA_MAX_ROUNDS; round++) {
    if (bestPassRate >= GEPA_MIN_PASS_RATE) break;

    let svc: EvolutionRunResponse;
    try {
      svc = await evolve({
        profileId: run.profileId,
        baseVersionId: run.baseVersionId,
        tier: run.tier,
        target: run.target,
        snapshot: workingSnapshot,
        evalTasks: goldenTasks,
        traces: await store.listTraces(run.profileId, 50),
      });
    } catch {
      await store.finalizeEvolutionFromService({
        runId: run.id,
        tenantId,
        status: "failed",
      });
      throw new Error("evolution_service_unavailable");
    }
    lastSvc = svc;
    if (!svc.mutations?.length) break;

    workingSnapshot = applyEvolutionMutations(workingSnapshot, svc.mutations);
    const roundVersionId = `${run.id}-gepa-${round}` as ProfileVersionId;
    const reeval = await runGoldenTaskAgentEval(store, {
      profileId: run.profileId,
      profileVersionId: roundVersionId,
      snapshot: workingSnapshot,
      agentRunner,
    });
    rounds.push({ round, passRate: reeval.passRate });

    if (reeval.passRate >= bestPassRate) {
      bestPassRate = reeval.passRate;
      bestRound = round;
      bestMutations = svc.mutations;
    }
    if (reeval.passRate >= GEPA_MIN_PASS_RATE) break;
  }

  if (!lastSvc) {
    return executeSingleEvolutionPipeline(store, run, tenantId, evolve);
  }

  return finalizeFromService(store, run, tenantId, lastSvc, {
    rounds,
    bestRound,
    baselinePassRate,
    finalPassRate: bestPassRate,
    mutations: bestMutations.length > 0 ? bestMutations : lastSvc.mutations,
  });
}

async function executeSingleEvolutionPipeline(
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

  const baselineEval = await runProfileEvaluation(store, run.profileId, run.baseVersionId);
  const baselinePassRate = baselineEval?.gate.passRate ?? 0;
  return finalizeFromService(store, run, tenantId, svc, {
    rounds: [{ round: 0, passRate: baselinePassRate }],
    bestRound: 0,
    baselinePassRate,
    finalPassRate: svc.gepaFinalPassRate ?? baselinePassRate,
    mutations: svc.mutations,
  });
}

export async function executeEvolutionPipeline(
  store: ControlPlaneStore,
  run: EvolutionRun,
  tenantId: TenantId,
  evolve: EvolutionInvoker,
  agentRunner: AgentGoldenTaskRunner = defaultSnapshotAwareGoldenTaskRunner,
): Promise<EvolutionPipelineResult | null> {
  const goldenTasks = await store.listGoldenTasks(run.profileId);
  if (goldenTasks.length > 0) {
    return executeGepaEvolutionPipeline(store, run, tenantId, evolve, agentRunner);
  }
  return executeSingleEvolutionPipeline(store, run, tenantId, evolve);
}
