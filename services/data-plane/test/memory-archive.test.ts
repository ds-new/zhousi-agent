import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { MemoryEntry, WorkspaceId } from "@diy-agent/domain";
import { getMemoryArchive, getMemoryStore, restoreMemoryArchive, runGovernancePipeline, type ArchivedMemory } from "@diy-agent/dsh-memory-plugin";
import { LocalFiles } from "../src/local-files.js";

it("persists and restores archive content and dates without crossing tenant or workspace boundaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diy-memory-archive-"));
  const workspaceId = "shared-workspace" as WorkspaceId;
  const tenantA = `archive-a-${crypto.randomUUID()}`;
  const tenantB = `archive-b-${crypto.randomUUID()}`;
  t.after(async () => {
    getMemoryStore(tenantA).delete(workspaceId);
    restoreMemoryArchive(tenantA, workspaceId, []);
    restoreMemoryArchive(tenantB, workspaceId, []);
    await rm(root, { recursive: true, force: true });
  });
  const createdAt = new Date(Date.now() - 60_000);
  const updatedAt = new Date(Date.now() - 30_000);
  const ttl = new Date(Date.now() + 86_400_000);
  const source: MemoryEntry[] = [
    { id: "approval", workspaceId, kind: "episodic", content: "Tenant A approved invoice 182 for 420 yuan.", createdAt, updatedAt, ttl },
    { id: "delivery", workspaceId, kind: "episodic", content: "Tenant A requires delivery on Friday.", createdAt, updatedAt, ttl },
  ];
  getMemoryStore(tenantA).set(workspaceId, source);
  await runGovernancePipeline(workspaceId, { workspaceId, maxEntries: 10, dedupSimilarityThreshold: 0.92, compactionTriggerCount: 1 }, tenantA);
  const archived = getMemoryArchive(tenantA, workspaceId);
  assert.equal(archived.length, 2);
  await new LocalFiles(root).write("memory-archive", [tenantA, workspaceId], archived);
  restoreMemoryArchive(tenantA, workspaceId, []);

  const restartedFiles = new LocalFiles(root);
  const persisted = await restartedFiles.read<ArchivedMemory[]>("memory-archive", [tenantA, workspaceId]);
  assert.ok(persisted);
  restoreMemoryArchive(tenantA, workspaceId, persisted);

  const restored = getMemoryArchive(tenantA, workspaceId);
  assert.deepEqual(restored, archived);
  assert.deepEqual(restored.map((entry) => entry.content), source.map((entry) => entry.content));
  for (const entry of restored) {
    for (const field of ["createdAt", "updatedAt", "ttl", "archivedAt", "expiresAt"] as const) {
      assert.ok(entry[field] instanceof Date, `${field} must survive JSON persistence as a Date`);
    }
  }
  assert.equal(await restartedFiles.read("memory-archive", [tenantB, workspaceId]), undefined);
  assert.deepEqual(getMemoryArchive(tenantB, workspaceId), []);
  assert.throws(() => restoreMemoryArchive(tenantA, "other-workspace", persisted), /invalid_memory_archive/);
  assert.deepEqual(getMemoryArchive(tenantA, "other-workspace"), []);
});
