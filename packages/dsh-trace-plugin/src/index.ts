/**
 * Eval trace collector — POST traces to Control Plane after each turn.
 */
export const name = "@diy-agent/dsh-trace-plugin";
export const inject = ["sessions"] as const;

export interface TracePayload {
  profileId: string;
  profileVersionId: string;
  output: string;
  latencyMs: number;
  toolCalls?: Array<{ name: string; ok: boolean }>;
  tokensUsed?: number;
}

const pending: TracePayload[] = [];

export function apply(ctx: {
  effect: (fn: () => void) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
}): void {
  ctx.effect(() => {
    ctx.on("session/turn-end", (...args: unknown[]) => {
      const payload = args[0] as TracePayload | undefined;
      if (!payload?.profileId) return;
      pending.push(payload);
      void flushTraces(process.env.DIY_CONTROL_PLANE_URL ?? "http://127.0.0.1:9878");
    });
  });
}

export async function flushTraces(controlPlaneUrl: string): Promise<void> {
  while (pending.length > 0) {
    const trace = pending.shift()!;
    try {
      await fetch(`${controlPlaneUrl}/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trace),
      });
    } catch {
      pending.unshift(trace);
      break;
    }
  }
}

export function getPendingTraces(): TracePayload[] {
  return pending;
}

export function resetTracesForTests(): void {
  pending.length = 0;
}
