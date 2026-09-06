import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluatePinGate,
  percentile,
  type EvalResult,
} from "../src/index.js";

describe("eval-harness pin gate", () => {
  it("evaluatePinGate passes when passRate and P95 meet thresholds", () => {
    const results: EvalResult[] = [
      {
        taskId: "t1",
        profileVersionId: "v1" as EvalResult["profileVersionId"],
        score: 1,
        latencyMs: 100,
        passed: true,
      },
      {
        taskId: "t2",
        profileVersionId: "v1" as EvalResult["profileVersionId"],
        score: 0.9,
        latencyMs: 200,
        passed: true,
      },
    ];
    const gate = evaluatePinGate(
      results,
      [
        { profileVersionId: "v1", output: "ok", latencyMs: 100 },
        { profileVersionId: "v1", output: "ok", latencyMs: 200 },
      ],
      { minPassRate: 0.8, maxP95LatencyMs: 5000 }
    );
    assert.equal(gate.passed, true);
    assert.equal(gate.passRate, 1);
  });

  it("evaluatePinGate fails when P95 exceeds max", () => {
    const results: EvalResult[] = [
      {
        taskId: "t1",
        profileVersionId: "v1" as EvalResult["profileVersionId"],
        score: 1,
        latencyMs: 100,
        passed: true,
      },
    ];
    const gate = evaluatePinGate(
      results,
      [{ profileVersionId: "v1", output: "ok", latencyMs: 10_000 }],
      { minPassRate: 0.8, maxP95LatencyMs: 5000 }
    );
    assert.equal(gate.passed, false);
    assert.ok(gate.reasons.some((r) => r.includes("p95_latency")));
  });

  it("percentile computes P95", () => {
    assert.equal(percentile([10, 20, 30, 40, 100], 95), 100);
  });
});
