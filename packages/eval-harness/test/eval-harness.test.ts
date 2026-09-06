import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePinGate, validateGoldenTaskCount } from "../src/index.js";

describe("eval-harness", () => {
  it("validateGoldenTaskCount requires at least 5 tasks", () => {
    assert.equal(validateGoldenTaskCount(4).ok, false);
    assert.equal(validateGoldenTaskCount(5).ok, true);
  });

  it("evaluatePinGate fails when pass rate below threshold", () => {
    const gate = evaluatePinGate(
      [
        { taskId: "1", profileVersionId: "v1", score: 0.5, latencyMs: 100, passed: false },
        { taskId: "2", profileVersionId: "v1", score: 1, latencyMs: 100, passed: true },
      ],
      [
        { profileVersionId: "v1", output: "x", latencyMs: 100 },
        { profileVersionId: "v1", output: "y", latencyMs: 9000 },
      ],
    );
    assert.equal(gate.passed, false);
    assert.ok(gate.reasons.length > 0);
  });
});
