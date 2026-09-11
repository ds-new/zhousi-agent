import type { AgentGoldenTaskRunner } from "../../src/golden-task-runner.js";
/** Deterministic fake model for orchestration tests; it never reads expectedContains. */
export const fixtureAgentRunner: AgentGoldenTaskRunner = (_task, snapshot) => ({
  output: snapshot.systemPrompt + " " + snapshot.mcpBindings.map(b => b.description ?? "").join(" "), latencyMs: 10, toolCalls: [{ name: "fixture", ok: true }],
});

/** Execute a real evaluation batch through the production runner seam, using a deterministic model fixture. */
export async function executeFixtureBenchmark(store: import("@diy-agent/db").ControlPlaneStore, profileId: string, versionId: string, output = "ok") {
  const { runGoldenTaskAgentEval } = await import("../../src/golden-task-runner.js");
  const version = await store.getProfileVersion(profileId as import("@diy-agent/domain").ProfileId, versionId as import("@diy-agent/domain").ProfileVersionId);
  if (!version) throw new Error("fixture_version_missing");
  return runGoldenTaskAgentEval(store, { profileId: version.profileId, profileVersionId: version.id, snapshot: version.snapshot,
    agentRunner: () => ({ output, latencyMs: 50, toolCalls: [{ name: "fixture", ok: true }] }) });
}
