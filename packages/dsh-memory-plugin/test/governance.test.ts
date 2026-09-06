import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MemoryEntry } from "@diy-agent/domain";
import { runGovernancePipeline } from "../src/index.js";

describe("memory L0 governance pipeline", () => {
  it("runs TTL then dedup stages in order", async () => {
    const ws = "ws-1" as MemoryEntry["workspaceId"];
    const policy = {
      workspaceId: ws,
      maxEntries: 100,
      dedupSimilarityThreshold: 0.92,
      compactionTriggerCount: 500,
      asyncCompaction: false,
    };

    const report = await runGovernancePipeline(ws, policy);
    assert.deepEqual(report.stages.slice(0, 2), ["ttl", "dedup"]);
  });
});
