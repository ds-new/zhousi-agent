import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrchestrator } from "../src/index.js";

describe("orchestrator metrics", () => {
  it("returns handoff metrics without affecting pin gate semantics", async () => {
    const orchestrator = createOrchestrator("supervisor", async task => `Executed: ${task.instruction}`);
    const plan = orchestrator.plan(
      "analyze sales data",
      { topology: "supervisor", workerProfileIds: ["w1", "w2"] as never[] },
      "supervisor-1" as import("@diy-agent/domain").ProfileId,
    );
    const result = await orchestrator.execute(plan);
    assert.equal(result.metrics.workerCount, 2);
    assert.ok(result.metrics.handoffCount >= 2);
    assert.ok(result.metrics.avgHandoffLatencyMs >= 0);
  });
});
