import type { ControlPlaneStore } from "@diy-agent/db";
import type { AgentGoldenTaskRunner } from "./golden-task-runner.js";
import { runGoldenTaskAgentEval } from "./golden-task-runner.js";
import { executeEvolutionPipeline, type EvolutionInvoker } from "./evolution-orchestrator.js";
import { tryAutoPinAfterEvolution } from "./evolution-closure.js";
import type { FireWebhookFn } from "./profile-pin.js";

/** One bounded scheduled feedback cycle. Only published profiles with a usable benchmark participate. */
export async function runEvolutionCycle(store: ControlPlaneStore, runner: AgentGoldenTaskRunner, evolve: EvolutionInvoker, fireWebhooks: FireWebhookFn) {
  return (await store.withLease("evolution:scheduled-cycle", async () => {
    const results: Array<{ profileId: string; status: string }> = [];
    for (const tenant of await store.listTenants()) {
      for (const entry of await store.listProfileSyncEntries(tenant.id)) {
        const profile = await store.getProfile(entry.profileId);
        if (!profile || !["L0", "L1"].includes(profile.governanceTier)) continue;
        const tasks = await store.listGoldenTasks(profile.id);
        if (tasks.length < 5 || tasks.length > 100) continue;
        try {
          const measured = await runGoldenTaskAgentEval(store, { profileId: profile.id, profileVersionId: entry.versionId,
            snapshot: entry.snapshot as never, agentRunner: runner });
          if (measured.gate?.passed) { results.push({ profileId: profile.id, status: "healthy" }); continue; }
          if (measured.passRate >= 0.75) { results.push({ profileId: profile.id, status: "degraded" }); continue; }
          const run = await store.createEvolutionRun({ tenantId: tenant.id, profileId: profile.id, trigger: "scheduled", target: "mcp_description", tier: "L1" });
          if (!run) continue;
          const pipeline = await executeEvolutionPipeline(store, run, tenant.id, evolve, runner);
          if (pipeline) {
            await tryAutoPinAfterEvolution(store, { profileId: profile.id, tenantId: tenant.id, evolutionRun: pipeline.run, fireWebhooks, agentRunner: runner });
            results.push({ profileId: profile.id, status: pipeline.run.status });
          }
        } catch {
          await store.appendAudit({ tenantId: tenant.id, workspaceId: profile.workspaceId, action: "evolution.cycle_failed", metadata: { profileId: profile.id } });
          results.push({ profileId: profile.id, status: "failed" });
        }
      }
    }
    return results;
  })) ?? [];
}
