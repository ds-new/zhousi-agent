/**
 * Multi-agent orchestration plugin — in-DSH goal handler (Phase 2).
 */
import type { OrchestrationConfig, ProfileId } from "@diy-agent/domain";
import { createOrchestrator } from "@diy-agent/orchestrator";

export const name = "@diy-agent/dsh-orchestrator-plugin";
export const inject = ["sessions"] as const;

interface Context {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  effect: (fn: () => void | (() => void)) => void;
}

export interface OrchestrationGoalEvent {
  goal: string;
  config: OrchestrationConfig;
  supervisorProfileId: ProfileId;
}

const goalHandlers: Array<(event: OrchestrationGoalEvent) => void> = [];

export function apply(ctx: Context): void {
  ctx.effect(() => {
    ctx.on("session/goal", (...args: unknown[]) => {
      const event = args[0] as OrchestrationGoalEvent | undefined;
      if (!event?.goal || !event.config || !event.supervisorProfileId) return;
      void runOrchestration(event.goal, event.config, event.supervisorProfileId).then(
        (result) => {
          for (const handler of goalHandlers) handler(event);
          void result;
        },
      );
    });
  });
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

export function onOrchestrationGoal(handler: (event: OrchestrationGoalEvent) => void): void {
  goalHandlers.push(handler);
}

export function resetOrchestrationHandlersForTests(): void {
  goalHandlers.length = 0;
}
