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

export function apply(ctx: Context): void {
  void ctx;
}

export async function runOrchestration(
  goal: string,
  config: OrchestrationConfig,
  supervisorId: ProfileId,
) {
  const orchestrator = createOrchestrator(config.topology);
  const plan = orchestrator.plan(goal, config, supervisorId);
  return orchestrator.execute(plan);
}
