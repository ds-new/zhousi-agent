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
}

export interface Orchestrator {
  plan(userGoal: string, config: OrchestrationConfig, supervisorId: ProfileId): OrchestrationPlan;
  execute(plan: OrchestrationPlan): Promise<OrchestrationResult>;
}

export class SupervisorOrchestrator implements Orchestrator {
  plan(userGoal: string, config: OrchestrationConfig, supervisorId: ProfileId): OrchestrationPlan {
    const workers = config.workerProfileIds ?? [];
    const subtasks = decomposeGoal(userGoal, workers.length || 1);
    const tasks = subtasks.map((instruction, i) => ({
      workerProfileId: workers[i] ?? (`worker-${i}` as ProfileId),
      instruction,
      status: "pending" as const,
    }));
    return { topology: "supervisor", supervisorProfileId: supervisorId, tasks };
  }

  async execute(plan: OrchestrationPlan): Promise<OrchestrationResult> {
    const handoffs: OrchestrationResult["handoffs"] = [];
    const outputs: string[] = [];
    const supervisor = plan.supervisorProfileId!;
    for (const task of plan.tasks) {
      const start = Date.now();
      task.status = "running";
      handoffs.push({
        from: supervisor,
        to: task.workerProfileId,
        latencyMs: Date.now() - start,
      });
      task.output = `[${task.workerProfileId}] ${task.instruction}`;
      task.status = "done";
      outputs.push(task.output);
    }
    return { plan, finalOutput: outputs.join("\n\n"), handoffs };
  }
}

export class PipelineOrchestrator implements Orchestrator {
  plan(userGoal: string, config: OrchestrationConfig, supervisorId: ProfileId): OrchestrationPlan {
    const workers = config.workerProfileIds ?? [];
    const stages = ["retrieve", "analyze", "respond"];
    const tasks = stages.map((stage, i) => ({
      workerProfileId: workers[i] ?? (`pipeline-${stage}` as ProfileId),
      instruction: `${stage}: ${userGoal}`,
      status: "pending" as const,
    }));
    return { topology: "pipeline", supervisorProfileId: supervisorId, tasks };
  }

  async execute(plan: OrchestrationPlan): Promise<OrchestrationResult> {
    let context = "";
    const handoffs: OrchestrationResult["handoffs"] = [];
    let prev: ProfileId | string = plan.supervisorProfileId!;
    for (const task of plan.tasks) {
      const start = Date.now();
      task.status = "running";
      handoffs.push({ from: prev, to: task.workerProfileId, latencyMs: 0 });
      task.output = `${task.instruction}${context ? `\ncontext: ${context.slice(0, 80)}` : ""}`;
      context = task.output;
      task.status = "done";
      handoffs[handoffs.length - 1]!.latencyMs = Date.now() - start;
      prev = task.workerProfileId;
    }
    return { plan, finalOutput: context, handoffs };
  }
}

export class BlackboardOrchestrator implements Orchestrator {
  plan(userGoal: string, config: OrchestrationConfig, supervisorId: ProfileId): OrchestrationPlan {
    const workers = config.workerProfileIds ?? [];
    const tasks = (workers.length ? workers : [("bb-1" as ProfileId)]).map((id) => ({
      workerProfileId: id,
      instruction: `Contribute to shared goal: ${userGoal}`,
      status: "pending" as const,
    }));
    return { topology: "blackboard", supervisorProfileId: supervisorId, tasks };
  }

  async execute(plan: OrchestrationPlan): Promise<OrchestrationResult> {
    const board: string[] = [];
    const handoffs: OrchestrationResult["handoffs"] = [];
    await Promise.all(
      plan.tasks.map(async (task) => {
        const start = Date.now();
        task.status = "running";
        task.output = `[blackboard] ${task.instruction}`;
        board.push(task.output);
        task.status = "done";
        handoffs.push({
          from: plan.supervisorProfileId!,
          to: task.workerProfileId,
          latencyMs: Date.now() - start,
        });
      }),
    );
    return { plan, finalOutput: board.join("\n---\n"), handoffs };
  }
}

export function createOrchestrator(topology: OrchestrationTopology): Orchestrator {
  switch (topology) {
    case "pipeline":
      return new PipelineOrchestrator();
    case "blackboard":
      return new BlackboardOrchestrator();
    case "supervisor":
    default:
      return new SupervisorOrchestrator();
  }
}

function decomposeGoal(goal: string, count: number): string[] {
  if (count <= 1) return [goal];
  return Array.from({ length: count }, (_, i) => `Subtask ${i + 1}/${count}: ${goal}`);
}
