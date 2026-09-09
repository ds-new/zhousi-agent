import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../src/memory-store.js";

describe("MemoryStore evolution finalize", () => {
  it("applies L1 mutations into a new candidate profile version", async () => {
    const store = new MemoryStore();
    const tenant = await store.createTenant({ name: "EvoCo" });
    const ws = await store.createWorkspace({ tenantId: tenant.id, name: "main" });
    const created = await store.createProfile({
      tenantId: tenant.id,
      workspaceId: ws!.id,
      profile: {
        name: "bot",
        systemPrompt: "You are helpful.",
        governanceTier: "L1",
        mcpBindings: [{ serverName: "lookup_order", transport: "stdio" }],
      },
    });
    assert.ok(created);
    const run = await store.createEvolutionRun({
      profileId: created.profile.id,
      tenantId: tenant.id,
      trigger: "manual",
      tier: "L1",
      target: "mcp_description",
    });
    assert.ok(run);

    const finalized = await store.finalizeEvolutionFromService({
      runId: run.id,
      tenantId: tenant.id,
      status: "completed",
      candidateVersionId: "candidate-v2" as import("@diy-agent/domain").ProfileVersionId,
      mutations: [
        {
          path: "mcp/lookup_order/description",
          before: "generic",
          after: "Validate order id before lookup.",
          tier: "L1",
        },
      ],
    });

    assert.ok(finalized);
    assert.equal(finalized!.status, "completed");
    const candidate = await store.getProfileVersion(created.profile.id, "candidate-v2");
    assert.equal(candidate?.snapshot.mcpBindings[0]?.description, "Validate order id before lookup.");
  });
});
