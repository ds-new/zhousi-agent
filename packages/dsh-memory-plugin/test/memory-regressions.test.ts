import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it } from "node:test";
import type { MemoryEntry, MemoryGovernancePolicy, WorkspaceId } from "@diy-agent/domain";
import { getMemoryStore, runGovernancePipeline } from "../src/index.js";

function memory(workspaceId: WorkspaceId, id: string, kind: MemoryEntry["kind"], content: string): MemoryEntry {
  return { id, workspaceId, kind, content, createdAt: new Date(), updatedAt: new Date() };
}

function policy(workspaceId: WorkspaceId, overrides: Partial<MemoryGovernancePolicy> = {}): MemoryGovernancePolicy {
  return { workspaceId, maxEntries: 100, dedupSimilarityThreshold: 0.92, compactionTriggerCount: 50, asyncCompaction: false, ...overrides };
}

describe("memory governance data preservation regressions", () => {
  it("retains distinct facts with an identical 200-character prefix", async (t) => {
    const ws = "regression-prefix" as WorkspaceId;
    const store = getMemoryStore();
    t.after(() => store.delete(ws));
    const prefix = "Shared operational context. ".repeat(10);
    store.set(ws, [
      memory(ws, "approved", "fact", `${prefix}The purchase was approved by Alice.`),
      memory(ws, "rejected", "fact", `${prefix}The purchase was rejected by Bob.`),
    ]);

    await runGovernancePipeline(ws, policy(ws));

    assert.deepEqual(store.get(ws)?.map((entry) => entry.id), ["approved", "rejected"]);
  });

  it("actually compacts at a configured trigger below fifty entries", async (t) => {
    const ws = "regression-trigger" as WorkspaceId;
    const store = getMemoryStore();
    t.after(() => store.delete(ws));
    store.set(ws, Array.from({ length: 4 }, (_, index) => memory(ws, `episode-${index}`, "episodic", `Task ${index} completed.`)));

    const report = await runGovernancePipeline(ws, policy(ws, { compactionTriggerCount: 3 }));

    assert.equal(report.compacted, true);
    assert.ok((store.get(ws)?.length ?? 0) < 4, "compaction must reduce the active entry count");
  });

  it("preserves useful source facts in compacted memory", async (t) => {
    const ws = "regression-content" as WorkspaceId;
    const store = getMemoryStore();
    t.after(() => store.delete(ws));
    const facts = Array.from({ length: 51 }, (_, index) => `Customer ${index} requires approval from owner-${index}.`);
    store.set(ws, facts.map((content, index) => memory(ws, `episode-${index}`, "episodic", content)));

    await runGovernancePipeline(ws, policy(ws));

    const retainedContent = store.get(ws)!.map((entry) => entry.content).join("\n");
    for (const fact of facts) {
      assert.ok(retainedContent.includes(fact), `missing useful fact: ${fact}`);
    }
  });

  it("enforces maxEntries when memory contains no episodic entries", async (t) => {
    const ws = "regression-capacity" as WorkspaceId;
    const store = getMemoryStore();
    t.after(() => store.delete(ws));
    store.set(ws, [
      memory(ws, "fact", "fact", "The customer operates in Shanghai."),
      memory(ws, "preference", "preference", "The customer prefers Chinese responses."),
      memory(ws, "procedure", "procedure", "Contact the owner before approving a purchase."),
    ]);

    await runGovernancePipeline(ws, policy(ws, { maxEntries: 2 }));

    assert.ok(store.get(ws)!.length <= 2, "maxEntries applies to every memory kind");
  });

  it("does not overwrite a new write after async governance returns", async (t) => {
    const ws = "regression-async-write" as WorkspaceId;
    const store = getMemoryStore();
    t.after(() => store.delete(ws));
    store.set(ws, Array.from({ length: 4 }, (_, index) => memory(ws, `episode-${index}`, "episodic", `Task ${index} completed.`)));

    await runGovernancePipeline(ws, policy(ws, { compactionTriggerCount: 3, asyncCompaction: true }));
    const newEntry = memory(ws, "new-write", "fact", "A new customer request arrived after governance returned.");
    store.set(ws, [...store.get(ws)!, newEntry]);
    await nextTurn();

    assert.ok(store.get(ws)!.some((entry) => entry.id === "new-write"), "a delayed compaction must preserve newer writes");
  });
});
