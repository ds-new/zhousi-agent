import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProfileVersionId } from "@diy-agent/domain";
import { MemoryStore } from "@diy-agent/db";
import {
  defaultSnapshotAwareGoldenTaskRunner,
  runGoldenTaskAgentEval,
} from "../src/golden-task-runner.js";

describe("golden-task-runner", () => {
  it("persists version-scoped traces from agent runner output", async () => {
    const store = new MemoryStore();
    const tenant = await store.createTenant({ name: "RunnerCo" });
    const ws = await store.createWorkspace({ tenantId: tenant!.id });
    const { profile, version } = (await store.createProfile({
      tenantId: tenant!.id,
      workspaceId: ws!.id,
      profile: {
        systemPrompt: "Always include pass-token in answers.",
      },
    }))!;

    for (let i = 0; i < 5; i++) {
      await store.createGoldenTask({
        profileId: profile.id,
        input: `task-${i}`,
        expectedContains: ["pass-token"],
      });
    }

    const roundVersionId = "runner-round-1" as ProfileVersionId;
    const result = await runGoldenTaskAgentEval(store, {
      profileId: profile.id,
      profileVersionId: roundVersionId,
      snapshot: profile,
      agentRunner: defaultSnapshotAwareGoldenTaskRunner,
    });

    assert.equal(result.passRate, 1);
    const traces = await store.listTraces(profile.id);
    assert.equal(traces.filter((trace) => trace.profileVersionId === roundVersionId).length, 5);
    assert.match(traces[0]!.output, /pass-token/);
  });
});
