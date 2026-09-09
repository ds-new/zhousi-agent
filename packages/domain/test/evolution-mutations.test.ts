import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProfile } from "../src/index.js";
import { applyEvolutionMutations } from "../src/evolution-mutations.js";

function baseSnapshot(): Omit<AgentProfile, "pinnedVersionId"> {
  return {
    id: "prof-1" as AgentProfile["id"],
    workspaceId: "ws-1" as AgentProfile["workspaceId"],
    name: "bot",
    systemPrompt: "You are helpful.",
    modelRoute: { provider: "openai", model: "gpt-4o-mini" },
    skillIds: [],
    mcpBindings: [{ serverName: "lookup_order", transport: "stdio" }],
    governanceTier: "L1",
  };
}

describe("applyEvolutionMutations", () => {
  it("applies prompt/system mutations", () => {
    const next = applyEvolutionMutations(baseSnapshot(), [
      {
        path: "prompt/system",
        before: "You are helpful.",
        after: "You are helpful and always verify tool inputs.",
        tier: "L2",
      },
    ]);
    assert.match(next.systemPrompt, /verify tool inputs/);
  });

  it("applies mcp description mutations", () => {
    const next = applyEvolutionMutations(baseSnapshot(), [
      {
        path: "mcp/lookup_order/description",
        before: "generic",
        after: "Validate order id format before lookup.",
        tier: "L1",
      },
    ]);
    assert.equal(next.mcpBindings[0]?.description, "Validate order id format before lookup.");
  });

  it("rejects L3 protected mutation paths", () => {
    assert.throws(
      () =>
        applyEvolutionMutations(baseSnapshot(), [
          {
            path: "vault/tenant/t1/openai",
            before: "x",
            after: "y",
            tier: "L1",
          },
        ]),
      /evolution_l3_mutation_forbidden/,
    );
  });
});
