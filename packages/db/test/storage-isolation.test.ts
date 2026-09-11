import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpBinding, ModelRoute } from "@diy-agent/domain";
import { MemoryStore } from "../src/memory-store.ts";

describe("profile storage isolation", () => {
  it("rejects creating a profile using another tenant's workspace", async () => {
    const store = new MemoryStore();
    const tenantA = await store.createTenant({ name: "Tenant A" });
    const tenantB = await store.createTenant({ name: "Tenant B" });
    const workspaceB = await store.createWorkspace({ tenantId: tenantB.id, name: "Private B" });
    assert.ok(workspaceB);

    const created = await store.createProfile({
      tenantId: tenantA.id,
      workspaceId: workspaceB.id,
      profile: { name: "Unauthorized profile" },
    });

    assert.equal(created, null);
  });

  it("preserves a version when the caller later edits the supplied model route", async () => {
    const store = new MemoryStore();
    const tenant = await store.createTenant({ name: "Immutable model" });
    const workspace = await store.createWorkspace({ tenantId: tenant.id });
    assert.ok(workspace);
    const modelRoute: ModelRoute = { provider: "openai", model: "approved-model" };
    const created = await store.createProfile({ tenantId: tenant.id, workspaceId: workspace.id, profile: { modelRoute } });
    assert.ok(created);

    modelRoute.model = "unreviewed-model";

    const persisted = await store.getProfileVersion(created.profile.id, created.version.id);
    assert.equal(persisted?.snapshot.modelRoute.model, "approved-model");
  });

  it("preserves a version when the caller later edits supplied MCP bindings", async () => {
    const store = new MemoryStore();
    const tenant = await store.createTenant({ name: "Immutable MCP" });
    const workspace = await store.createWorkspace({ tenantId: tenant.id });
    assert.ok(workspace);
    const mcpBindings: McpBinding[] = [{ serverName: "knowledge", transport: "stdio", command: "reader", args: ["--readonly"] }];
    const created = await store.createProfile({ tenantId: tenant.id, workspaceId: workspace.id, profile: { mcpBindings } });
    assert.ok(created);

    mcpBindings[0]!.args![0] = "--write";
    mcpBindings.push({ serverName: "unreviewed", transport: "stdio", command: "writer" });

    const persisted = await store.getProfileVersion(created.profile.id, created.version.id);
    assert.deepEqual(persisted?.snapshot.mcpBindings, [{ serverName: "knowledge", transport: "stdio", command: "reader", args: ["--readonly"] }]);
  });

  it("preserves approved snapshots when a retrieved profile is edited", async () => {
    const store = new MemoryStore();
    const tenant = await store.createTenant({ name: "Immutable reads" });
    const workspace = await store.createWorkspace({ tenantId: tenant.id });
    assert.ok(workspace);
    const created = await store.createProfile({
      tenantId: tenant.id,
      workspaceId: workspace.id,
      profile: {
        modelRoute: { provider: "openai", model: "approved-model" },
        mcpBindings: [{ serverName: "knowledge", transport: "stdio", args: ["--readonly"] }],
      },
    });
    assert.ok(created);
    const profile = await store.getProfile(created.profile.id);
    assert.ok(profile);

    profile.modelRoute.model = "unreviewed-model";
    profile.mcpBindings[0]!.args![0] = "--write";

    const persisted = await store.getProfileVersion(created.profile.id, created.version.id);
    assert.equal(persisted?.snapshot.modelRoute.model, "approved-model");
    assert.deepEqual(persisted?.snapshot.mcpBindings[0]?.args, ["--readonly"]);
  });
});
