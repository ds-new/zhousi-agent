/**
 * Multi-agent orchestration plugin — default supervisor topology.
 */

import type { OrchestrationConfig, ProfileId } from "@diy-agent/domain";
import { createOrchestrator } from "@diy-agent/orchestrator";

export const name = "@diy-agent/dsh-orchestrator-plugin";
export const inject = ["sessions"] as const;

interface Context {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  effect: (fn: () => void | (() => void)) => void;
}

const DEFAULT_CONFIG: OrchestrationConfig = {
  topology: "supervisor",
  workerProfileIds: [],
};

export function apply(ctx: Context): void {
  ctx.effect(() => {
    ctx.on("session/user-message", (...args: unknown[]) => {
      const payload = args[0] as {
        goal?: string;
        profileId?: ProfileId;
        orchestration?: OrchestrationConfig;
      };
      if (!payload?.goal || !payload.profileId) return;
      void runOrchestration(
        payload.goal,
        payload.orchestration ?? DEFAULT_CONFIG,
        payload.profileId
      );
    });
  });
}

export async function runOrchestration(
  goal: string,
  config: OrchestrationConfig,
  supervisorId: ProfileId
) {
  const orchestrator = createOrchestrator(config.topology);
  const plan = orchestrator.plan(goal, config, supervisorId);
  return orchestrator.execute(plan);
}
