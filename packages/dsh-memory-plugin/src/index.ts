/**
 * L0 Memory self-governance pipeline: TTL → dedup → compaction (async).
 */

import type { MemoryEntry, MemoryGovernancePolicy } from "@diy-agent/domain";

export const name = "@diy-agent/dsh-memory-plugin";
export const inject = ["sessions"] as const;

interface Context {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  effect: (fn: () => void | (() => void)) => void;
}

const store = new Map<string, MemoryEntry[]>();

export function apply(ctx: Context): void {
  ctx.effect(() => {
    ctx.on("session/turn-end", (...args: unknown[]) => {
      const payload = args[0] as { workspaceId?: string };
      if (!payload?.workspaceId) return;
      void runGovernancePipeline(
        payload.workspaceId,
        defaultPolicy(payload.workspaceId)
      );
    });
  });
}

function defaultPolicy(workspaceId: string): MemoryGovernancePolicy {
  return {
    workspaceId: workspaceId as MemoryGovernancePolicy["workspaceId"],
    maxEntries: 10_000,
    defaultTtlDays: 90,
    dedupSimilarityThreshold: 0.92,
    compactionTriggerCount: 500,
    asyncCompaction: true,
  };
}

export interface GovernanceReport {
  expired: number;
  deduped: number;
  compacted: boolean;
  stages: Array<"ttl" | "dedup" | "compaction">;
}

/** L0: automatic, no human review — A → B → C */
export async function runGovernancePipeline(
  workspaceId: string,
  policy: MemoryGovernancePolicy
): Promise<GovernanceReport> {
  const entries = store.get(workspaceId) ?? [];
  const stages: GovernanceReport["stages"] = [];

  // Stage A: TTL
  stages.push("ttl");
  const now = Date.now();
  const afterTtl = applyTtl(entries, now);
  const expired = entries.length - afterTtl.length;

  // Stage B: dedup
  stages.push("dedup");
  const deduped = deduplicate(afterTtl, policy.dedupSimilarityThreshold);
  const dedupCount = afterTtl.length - deduped.length;

  // Stage C: compaction (async-safe — does not block caller when flagged)
  let compacted = false;
  let final = deduped;
  if (deduped.length > policy.compactionTriggerCount) {
    stages.push("compaction");
    const runCompaction = () => {
      final = compact(deduped, policy.maxEntries);
      store.set(workspaceId, final);
    };
    if (policy.asyncCompaction) {
      setImmediate(runCompaction);
      compacted = true;
    } else {
      runCompaction();
      compacted = true;
    }
  } else {
    store.set(workspaceId, final);
  }

  return { expired, deduped: dedupCount, compacted, stages };
}

function applyTtl(entries: MemoryEntry[], now: number): MemoryEntry[] {
  return entries.filter((e) => !e.ttl || e.ttl.getTime() > now);
}

function deduplicate(
  entries: MemoryEntry[],
  threshold: number
): MemoryEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = e.content.slice(0, 200);
    if (seen.has(key)) return false;
    seen.add(key);
    return threshold > 0;
  });
}

function compact(entries: MemoryEntry[], max: number): MemoryEntry[] {
  return entries
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, max);
}

export function getMemoryStore(): Map<string, MemoryEntry[]> {
  return store;
}
