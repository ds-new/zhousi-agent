import assert from "node:assert/strict";
import { it } from "node:test";
import { createOrchestrator } from "../src/index.js";

it("does not claim success without an executor", async () => {
  const o = createOrchestrator("pipeline");
  await assert.rejects(o.execute(o.plan("goal", { topology: "pipeline" }, "root" as never)), /worker_executor_required/);
});

it("executes all pipeline workers and passes full output to the next stage", async () => {
  const inputs: string[] = [];
  const output = "evidence ".repeat(100);
  const o = createOrchestrator("pipeline", async (_task, context) => { inputs.push(context); return output; });
  const result = await o.execute(o.plan("goal", { topology: "pipeline", workerProfileIds: ["a", "b", "c", "d"] as never[] }, "root" as never));
  assert.equal(inputs.length, 4);
  assert.equal(inputs[1], output);
  assert.equal(result.finalOutput, output);
});
