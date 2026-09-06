import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVAL_TRACE_RETENTION_DAYS, isTraceExpired } from "@diy-agent/domain";
import { MemoryStore } from "../src/memory-store.js";
import type { ProfileId } from "@diy-agent/domain";

describe("eval trace retention", () => {
  it("isTraceExpired uses 90-day window", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const fresh = new Date("2025-12-01T00:00:00Z");
    const stale = new Date("2025-09-01T00:00:00Z");
    assert.equal(isTraceExpired(fresh, now), false);
    assert.equal(isTraceExpired(stale, now), true);
    assert.equal(EVAL_TRACE_RETENTION_DAYS, 90);
  });

  it("saveTrace purges traces older than retention window", async () => {
    const store = new MemoryStore();
    const profileId = "profile-1" as ProfileId;
    const versionId = "version-1" as import("@diy-agent/domain").ProfileVersionId;

    const staleDate = new Date(Date.now() - (EVAL_TRACE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    (store as unknown as { traces: Map<string, unknown> }).traces.set("old", {
      id: "old",
      profileId,
      profileVersionId: versionId,
      output: "stale",
      latencyMs: 1,
      createdAt: staleDate,
    });

    await store.saveTrace({
      profileId,
      profileVersionId: versionId,
      output: "fresh",
      latencyMs: 10,
    });

    const traces = await store.listTraces(profileId);
    assert.equal(traces.length, 1);
    assert.equal(traces[0]!.output, "fresh");
  });
});
