import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { resetInternalIndexForTests } from "@diy-agent/kb-rag";
import {
  storeProfileBootstrapBundle,
  buildProfileBootstrapBundle,
  resetBootstrapCacheForTests,
} from "@diy-agent/dsh-bootstrap-plugin";
import {
  createKbRuntime,
  getKbConfigFromBundle,
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
    resetBootstrapCacheForTests();
  });

  it("reads kbConfig from ProfileBootstrapBundle", () => {
    storeProfileBootstrapBundle(
      buildProfileBootstrapBundle({
        profileId: "prof-1" as import("@diy-agent/domain").ProfileId,
        profileVersionId: "ver-1" as import("@diy-agent/domain").ProfileVersionId,
        workspaceId: "ws-1" as import("@diy-agent/domain").WorkspaceId,
        tenantId: "t-1" as import("@diy-agent/domain").TenantId,
        snapshot: {
          kbConfig: {
            internal: { enabled: true },
            externalMcp: {
              serverName: "bundle-search",
              transport: "stdio",
              sensitivity: "readonly",
            },
          },
        },
      }),
    );

    const config = getKbConfigFromBundle("prof-1", "ver-1");
    assert.equal(config.externalMcp?.serverName, "bundle-search");
  });

  it("resolveKbConfigFromSnapshot delegates to getKbConfigFromBundle", () => {
    storeProfileBootstrapBundle(
      buildProfileBootstrapBundle({
        profileId: "prof-2" as import("@diy-agent/domain").ProfileId,
        profileVersionId: "ver-2" as import("@diy-agent/domain").ProfileVersionId,
        workspaceId: "ws-2" as import("@diy-agent/domain").WorkspaceId,
        tenantId: "t-2" as import("@diy-agent/domain").TenantId,
        snapshot: { kbConfig: { internal: { enabled: true } } },
      }),
    );

    const config = resolveKbConfigFromSnapshot("prof-2", "ver-2");
    assert.equal(config.internal?.enabled, true);
  });

  it("throws kb_config_unavailable when bootstrap bundle misses", () => {
    assert.throws(() => getKbConfigFromBundle("missing", "ver-1"), /kb_config_unavailable/);
  });
});

describe("dsh-kb-plugin kb_search tool", () => {
  beforeEach(() => {
    resetInternalIndexForTests();
    resetKbRuntimeForTests();
    resetKbPluginForTests();
    resetBootstrapCacheForTests();
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
