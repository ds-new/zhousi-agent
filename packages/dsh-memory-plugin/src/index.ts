/**
 * L0 Memory self-governance pipeline: TTL → dedup → compaction (async).
 */
import type { MemoryEntry, MemoryGovernancePolicy, WorkspaceId } from "@diy-agent/domain";

export const name = "@diy-agent/dsh-memory-plugin";
export const inject = ["sessions"] as const;

const store = new Map<string, MemoryEntry[]>();

interface Context {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  effect: (fn: () => void | (() => void)) => void;
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    ctx.on("session/turn-end", (...args: unknown[]) => {
      const payload = args[0] as { workspaceId?: string } | undefined;
      if (!payload?.workspaceId) return;
      void runGovernancePipeline(payload.workspaceId, defaultPolicy(payload.workspaceId));
    });
  });
}

function defaultPolicy(workspaceId: string): MemoryGovernancePolicy {
  return {
    workspaceId: workspaceId as WorkspaceId,
    maxEntries: 10_000,
    defaultTtlDays: 90,
    dedupSimilarityThreshold: 0.92,
    compactionTriggerCount: 50,
    asyncCompaction: true,
  };
}

export interface GovernanceReport {
  expired: number;
  deduped: number;
  compacted: boolean;
  stages: Array<"ttl" | "dedup" | "compaction">;
}

export async function runGovernancePipeline(
  workspaceId: string,
  policy: MemoryGovernancePolicy,
): Promise<GovernanceReport> {
  const entries = store.get(workspaceId) ?? [];
  const stages: GovernanceReport["stages"] = ["ttl"];
  const now = Date.now();
  const afterTtl = applyTtl(entries, now);
  const expired = entries.length - afterTtl.length;

  stages.push("dedup");
  const deduped = deduplicateByKind(afterTtl, policy.dedupSimilarityThreshold);
  const dedupCount = afterTtl.length - deduped.length;

  let compacted = false;
  let final = deduped;
  if (deduped.filter((e) => e.kind === "episodic").length > policy.compactionTriggerCount) {
    stages.push("compaction");
    const runCompaction = () => {
      final = compactEpisodic(deduped, policy.maxEntries);
      store.set(workspaceId, final);
    };
    if (policy.asyncCompaction) {
      setImmediate(runCompaction);
    } else {
      runCompaction();
    }
    compacted = true;
  } else {
    store.set(workspaceId, final);
  }

  return { expired, deduped: dedupCount, compacted, stages };
}

function applyTtl(entries: MemoryEntry[], now: number): MemoryEntry[] {
  return entries.filter((e) => !e.ttl || e.ttl.getTime() > now);
}

function deduplicateByKind(entries: MemoryEntry[], threshold: number): MemoryEntry[] {
  const seen = new Map<string, Set<string>>();
  return entries.filter((e) => {
    const kindKey = e.kind;
    const fingerprints = seen.get(kindKey) ?? new Set<string>();
    const fp = e.content.slice(0, 200);
    if (fingerprints.has(fp)) return false;
    fingerprints.add(fp);
    seen.set(kindKey, fingerprints);
    return threshold > 0;
  });
}

function compactEpisodic(entries: MemoryEntry[], max: number): MemoryEntry[] {
  const episodic = entries.filter((e) => e.kind === "episodic");
  const rest = entries.filter((e) => e.kind !== "episodic");
  if (episodic.length <= 50) {
    return entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, max);
  }
  const summary: MemoryEntry = {
    id: crypto.randomUUID(),
    workspaceId: episodic[0]!.workspaceId,
    kind: "procedure",
    content: `[compacted ${episodic.length} episodic entries]`,
    createdAt: new Date(),
    updatedAt: new Date(),
    ttl: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  };
  const kept = [...rest, summary]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, max);
  return kept;
}

export function getMemoryStore(): Map<string, MemoryEntry[]> {
  return store;
}
