import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runGovernancePipeline } from "../src/index.js";
import type { MemoryEntry, WorkspaceId } from "@diy-agent/domain";
import { getMemoryStore } from "../src/index.js";

describe("memory governance", () => {
  it("runs ttl and dedup stages", async () => {
    const ws = "ws-1" as WorkspaceId;
    const store = getMemoryStore();
    store.set(ws, [
      {
        id: "1",
        workspaceId: ws,
        kind: "fact",
        content: "duplicate content here",
        createdAt: new Date(),
        updatedAt: new Date(),
        ttl: new Date(Date.now() - 1000),
      },
      {
        id: "2",
        workspaceId: ws,
        kind: "fact",
        content: "duplicate content here",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as MemoryEntry[]);

    const report = await runGovernancePipeline(ws, {
      workspaceId: ws,
      maxEntries: 100,
      dedupSimilarityThreshold: 0.92,
      compactionTriggerCount: 50,
      asyncCompaction: false,
    });

    assert.ok(report.stages.includes("ttl"));
    assert.ok(report.stages.includes("dedup"));
    assert.equal(report.expired, 1);
    assert.equal(report.deduped, 0);
  });
});
