import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { resetInternalIndexForTests } from "@diy-agent/kb-rag";
import { cacheProfileSnapshot } from "@diy-agent/dsh-tenant-plugin";
import { handleProfilePinnedWebhook } from "@diy-agent/dsh-profile-sync-plugin";
import {
  createKbRuntime,
  registerKbSearchTool,
  resetKbPluginForTests,
  resetKbRuntimeForTests,
  resolveKbConfigFromSnapshot,
} from "../src/index.js";

describe("dsh-kb-plugin snapshot resolver", () => {
  beforeEach(() => {
    resetInternalIndexForTests();
    resetKbRuntimeForTests();
    resetKbPluginForTests();
  });

  it("prefers profile-sync cache over tenant-plugin cache", () => {
    cacheProfileSnapshot("prof-1", "ver-1", {
      snapshot: { kbConfig: { internal: { enabled: true } } },
      credentialRefIds: [],
    });
    handleProfilePinnedWebhook({
      profileId: "prof-1",
      versionId: "ver-1",
      snapshot: {
        kbConfig: {
          internal: { enabled: true },
          externalMcp: {
            serverName: "sync-search",
            transport: "stdio",
            sensitivity: "readonly",
          },
        },
      },
    });

    const config = resolveKbConfigFromSnapshot("prof-1", "ver-1");
    assert.equal(config.externalMcp?.serverName, "sync-search");
  });

  it("throws kb_config_unavailable when caches miss", () => {
    assert.throws(() => resolveKbConfigFromSnapshot("missing", "ver-1"), /kb_config_unavailable/);
  });
});

describe("dsh-kb-plugin kb_search tool", () => {
  beforeEach(() => {
    resetInternalIndexForTests();
    resetKbRuntimeForTests();
    resetKbPluginForTests();
  });

  it("searches internal KB via registered tool handler", async () => {
    const runtime = createKbRuntime();
    const tools = {
      handlers: new Map<string, (args: unknown) => Promise<unknown>>(),
      register(name: string, handler: (args: unknown) => Promise<unknown>) {
        this.handlers.set(name, handler);
      },
    };

    registerKbSearchTool(tools, runtime, {
      workspaceId: "ws-1" as import("@diy-agent/domain").WorkspaceId,
      profileId: "prof-1" as import("@diy-agent/domain").ProfileId,
      profileVersionId: "ver-1" as import("@diy-agent/domain").ProfileVersionId,
      kbConfig: { internal: { enabled: true } },
    });

    await runtime.ingest({
      workspaceId: "ws-1" as import("@diy-agent/domain").WorkspaceId,
      title: "Returns",
      content: "Refund within 30 days.",
      kbConfig: { internal: { enabled: true } },
    });

    const handler = tools.handlers.get("kb_search");
    assert.ok(handler);
    const result = (await handler!({ query: "refund policy" })) as { hits: Array<{ title: string }> };
    assert.equal(result.hits[0]?.title, "Returns");
  });
});
