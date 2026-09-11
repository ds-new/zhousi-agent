import type {
  OrchestrationConfig,
  OrchestrationTopology,
  ProfileId,
} from "@diy-agent/domain";

export interface WorkerTask {
  workerProfileId: ProfileId | string;
  instruction: string;
  status: "pending" | "running" | "done" | "failed";
  output?: string;
}

export interface OrchestrationPlan {
  topology: OrchestrationTopology;
  supervisorProfileId?: ProfileId;
  tasks: WorkerTask[];
}

export interface OrchestrationResult {
  plan: OrchestrationPlan;
  finalOutput: string;
  handoffs: Array<{ from: ProfileId | string; to: ProfileId | string; latencyMs: number }>;
  metrics: {
    handoffCount: number;
    avgHandoffLatencyMs: number;
    workerCount: number;
  };
}

export interface Orchestrator {
  plan(userGoal: string, config: OrchestrationConfig, supervisorId: ProfileId): OrchestrationPlan;
  execute(plan: OrchestrationPlan): Promise<OrchestrationResult>;
}

export type WorkerExecutor = (task: Readonly<WorkerTask>, context: string) => Promise<string>;

class ExecutingOrchestrator implements Orchestrator {
  constructor(private topology: OrchestrationTopology, private executor?: WorkerExecutor) {}

  plan(userGoal: string, config: OrchestrationConfig, supervisorId: ProfileId): OrchestrationPlan {
    const workers = config.workerProfileIds?.length ? config.workerProfileIds : [supervisorId];
    if (workers.length > 32) throw new Error("orchestration_worker_limit");
    return { topology: this.topology, supervisorProfileId: supervisorId,
      tasks: workers.map((id, i) => ({ workerProfileId: id, instruction: this.topology === "pipeline" ? `Stage ${i + 1}: ${userGoal}` : userGoal, status: "pending" })),
    };
  }

  async execute(plan: OrchestrationPlan): Promise<OrchestrationResult> {
    if (!this.executor) throw new Error("worker_executor_required");
    const handoffs: OrchestrationResult["handoffs"] = [];
    const outputs: string[] = [];
    let previous = plan.supervisorProfileId! as string;
    for (const task of plan.tasks) {
      const start = performance.now();
      task.status = "running";
      const context = this.topology === "pipeline" ? outputs.at(-1) ?? "" : outputs.join("\n\n");
      try {
        task.output = await this.executor(task, context);
        if (typeof task.output !== "string" || !task.output.trim()) throw new Error("worker_empty_output");
        task.status = "done";
        outputs.push(task.output);
      } catch (error) { task.status = "failed"; throw error; }
      handoffs.push({ from: previous, to: task.workerProfileId, latencyMs: performance.now() - start });
      previous = task.workerProfileId;
    }
    return { plan, finalOutput: this.topology === "pipeline" ? outputs.at(-1) ?? "" : outputs.join("\n\n"), handoffs, metrics: buildMetrics(plan, handoffs) };
  }
}

export class SupervisorOrchestrator extends ExecutingOrchestrator {
  constructor(executor?: WorkerExecutor) { super("supervisor", executor); }
}
export class PipelineOrchestrator extends ExecutingOrchestrator {
  constructor(executor?: WorkerExecutor) { super("pipeline", executor); }
}
export class BlackboardOrchestrator extends ExecutingOrchestrator {
  constructor(executor?: WorkerExecutor) { super("blackboard", executor); }
}
export function createOrchestrator(topology: OrchestrationTopology, executor?: WorkerExecutor): Orchestrator {
  if (!["supervisor", "pipeline", "blackboard"].includes(topology)) throw new Error("invalid_orchestration_topology");
  return new ExecutingOrchestrator(topology, executor);
}

function buildMetrics(
  plan: OrchestrationPlan,
  handoffs: OrchestrationResult["handoffs"],
): OrchestrationResult["metrics"] {
  const handoffCount = handoffs.length;
  const avgHandoffLatencyMs =
    handoffCount === 0
      ? 0
      : handoffs.reduce((sum, h) => sum + h.latencyMs, 0) / handoffCount;
  return {
    handoffCount,
    avgHandoffLatencyMs,
    workerCount: plan.tasks.length,
  };
}
