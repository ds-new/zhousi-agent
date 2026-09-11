/**
 * L0 Memory self-governance pipeline: TTL → dedup → compaction (async).
 */
import type { MemoryEntry, MemoryGovernancePolicy, WorkspaceId } from "@diy-agent/domain";

export const name = "@diy-agent/dsh-memory-plugin";
export const inject = ["sessions"] as const;

const stores = new Map<string, Map<string, MemoryEntry[]>>();
export type ArchivedMemory = MemoryEntry & { archivedAt: Date; expiresAt: Date };
const archives = new Map<string, ArchivedMemory[]>();


interface Context {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  effect: (fn: () => void | (() => void)) => void;
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    ctx.on("session/turn-end", (...args: unknown[]) => {
      const payload = args[0] as { tenantId?: string; workspaceId?: string } | undefined;
      if (!payload?.tenantId || !payload.workspaceId) return;
      void runGovernancePipeline(payload.workspaceId, defaultPolicy(payload.workspaceId), payload.tenantId)
        .catch(error => console.error("memory_governance_failed", { tenantId: payload.tenantId, workspaceId: payload.workspaceId, error: String(error) }));
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
  tenantId = "development",
): Promise<GovernanceReport> {
  const result = governMemory(workspaceId, policy, getMemoryStore(tenantId).get(workspaceId) ?? [], getMemoryArchive(tenantId, workspaceId));
  getMemoryStore(tenantId).set(workspaceId, result.entries);
  archives.set(JSON.stringify([tenantId, workspaceId]), result.archive);
  return result.report;
}

/** Pure transformation: callers may atomically commit active entries and archive in one DB transaction. */
export function governMemory(workspaceId: string, policy: MemoryGovernancePolicy, entries: MemoryEntry[], priorArchive: ArchivedMemory[] = []) {
  if (policy.workspaceId !== workspaceId || !Number.isInteger(policy.maxEntries) || policy.maxEntries < 1 ||
      (policy.defaultTtlDays !== undefined && (!Number.isFinite(policy.defaultTtlDays) || policy.defaultTtlDays <= 0)) ||
      !Number.isFinite(policy.dedupSimilarityThreshold) || policy.dedupSimilarityThreshold < 0 || policy.dedupSimilarityThreshold > 1 ||
      !Number.isInteger(policy.compactionTriggerCount) || policy.compactionTriggerCount < 1) throw new Error("invalid_memory_policy");
  const now = Date.now();
  const archive = priorArchive.filter(e => e.expiresAt.getTime() > now).map(e => structuredClone(e));
  const active: MemoryEntry[] = [];
  let expired = 0;
  let deduped = 0;
  const seen = new Set<string>();
  const retire = (e: MemoryEntry) => archive.push({ ...structuredClone(e), archivedAt: new Date(now), expiresAt: new Date(now + 30 * 86400000) });
  for (const entry of entries) {
    if (entry.workspaceId !== workspaceId) throw new Error("memory_workspace_mismatch");
    const ttl = entry.ttl?.getTime() ?? (policy.defaultTtlDays ? entry.createdAt.getTime() + policy.defaultTtlDays * 86400000 : Infinity);
    if (ttl <= now) { expired++; retire(entry); continue; }
    // Conservative full-content normalization: similarity alone cannot distinguish contradictory facts.
    const fingerprint = JSON.stringify([entry.kind, entry.content.normalize("NFKC").replace(/\s+/g, " ").trim()]);
    if (seen.has(fingerprint)) { deduped++; retire(entry); continue; }
    seen.add(fingerprint);
    active.push(entry);
  }
  const stages: GovernanceReport["stages"] = ["ttl", "dedup"];
  const episodic = active.filter(e => e.kind === "episodic");
  const compacted = episodic.length > policy.compactionTriggerCount;
  let final = active;
  if (compacted) {
    stages.push("compaction");
    episodic.forEach(retire);
    final = active.filter(e => e.kind !== "episodic");
    final.push({
      id: crypto.randomUUID(), workspaceId: policy.workspaceId, kind: "procedure",
      content: episodic.map(e => e.content).join("\n"),
      createdAt: new Date(now), updatedAt: new Date(now),
      ttl: new Date(now + (policy.defaultTtlDays ?? 90) * 86400000),
    });
  }
  if (final.length > policy.maxEntries) {
    final.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    final.slice(policy.maxEntries).forEach(retire);
    final = final.slice(0, policy.maxEntries);
  }
  // Bound bytes as well as count so long-lived workspaces cannot grow without limit.
  let activeBytes = final.reduce((n, e) => n + Buffer.byteLength(e.content), 0);
  final.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  while (activeBytes > 512 * 1024 && final.length) {
    const retired = final.pop()!; activeBytes -= Buffer.byteLength(retired.content); retire(retired);
  }
  let archiveBytes = archive.reduce((n, e) => n + Buffer.byteLength(e.content), 0);
  while (archiveBytes > 4 * 1024 * 1024 && archive.length) archiveBytes -= Buffer.byteLength(archive.shift()!.content);
  return { entries: final, archive, report: { expired, deduped, compacted, stages } };
}

export function getMemoryStore(tenantId = "development"): Map<string, MemoryEntry[]> {
  if (!tenantId.trim()) throw new Error("memory_tenant_required");
  let scoped = stores.get(tenantId);
  if (!scoped) { scoped = new Map(); stores.set(tenantId, scoped); }
  return scoped;
}

export function getMemoryArchive(tenantId: string, workspaceId: string): ArchivedMemory[] {
  return structuredClone((archives.get(JSON.stringify([tenantId, workspaceId])) ?? []).filter(e => e.expiresAt.getTime() > Date.now()));
}

export function restoreMemoryArchive(tenantId: string, workspaceId: string, entries: ArchivedMemory[]): void {
  if (!tenantId.trim() || entries.some(e => e.workspaceId !== workspaceId || !(e.expiresAt instanceof Date))) throw new Error("invalid_memory_archive");
  archives.set(JSON.stringify([tenantId, workspaceId]), structuredClone(entries.filter(e => e.expiresAt.getTime() > Date.now())));
}
