import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import type { McpCatalogEntry } from "@diy-agent/domain";
import { defaultWorkspaceAccessPolicy } from "@diy-agent/domain";
import { getWorkspacePolicy } from "@diy-agent/dsh-policy-plugin";
import {
  apply,
  applyBootstrapToRuntime,
  assertMcpCatalogApproved,
  buildProfileBootstrapBundle,
  deriveBlockedMcpServers,
  materializeProfileBootstrapBundle,
  materializeProfileBootstrapBundleFromSync,
  resetBootstrapCacheForTests,
  storeProfileBootstrapBundle,
} from "../src/index.js";

describe("dsh-bootstrap-plugin bundle", () => {
  beforeEach(() => resetBootstrapCacheForTests());

  it("derives blocked MCP servers from pending catalog entries", () => {
    const catalog: McpCatalogEntry[] = [
      {
        serverName: "approved-one",
        tenantId: "t-1" as import("@diy-agent/domain").TenantId,
        transport: "stdio",
        defaultSensitivity: "readonly",
        approvalStatus: "approved",
        createdAt: new Date(),
      },
      {
        serverName: "pending-one",
        tenantId: "t-1" as import("@diy-agent/domain").TenantId,
        transport: "stdio",
        defaultSensitivity: "normal",
        approvalStatus: "pending",
        createdAt: new Date(),
      },
    ];
    assert.deepEqual(deriveBlockedMcpServers(catalog), ["pending-one"]);
  });

  it("assertMcpCatalogApproved rejects blocked servers", () => {
    const bundle = buildProfileBootstrapBundle({
      profileId: "prof-1" as import("@diy-agent/domain").ProfileId,
      profileVersionId: "ver-1" as import("@diy-agent/domain").ProfileVersionId,
      workspaceId: "ws-1" as import("@diy-agent/domain").WorkspaceId,
      tenantId: "t-1" as import("@diy-agent/domain").TenantId,
      snapshot: {},
      mcpCatalog: [
        {
          serverName: "pending-one",
          tenantId: "t-1" as import("@diy-agent/domain").TenantId,
          transport: "stdio",
          defaultSensitivity: "normal",
          approvalStatus: "pending",
          createdAt: new Date(),
        },
      ],
    });
    assert.throws(
      () => assertMcpCatalogApproved("pending-one", bundle),
      /mcp_catalog_not_approved:pending-one/,
    );
  });

  it("applyBootstrapToRuntime injects workspace policy", () => {
    const policy = defaultWorkspaceAccessPolicy("ws-1" as import("@diy-agent/domain").WorkspaceId);
    policy.rules.unshift({ effect: "allow", toolPattern: "mcp__test__*", sensitivity: "high" });
    const bundle = buildProfileBootstrapBundle({
      profileId: "prof-1" as import("@diy-agent/domain").ProfileId,
      profileVersionId: "ver-1" as import("@diy-agent/domain").ProfileVersionId,
      workspaceId: "ws-1" as import("@diy-agent/domain").WorkspaceId,
      tenantId: "t-1" as import("@diy-agent/domain").TenantId,
      snapshot: { kbConfig: { internal: { enabled: true } } },
      policy,
    });
    applyBootstrapToRuntime(bundle);
    const injected = getWorkspacePolicy("ws-1");
    assert.equal(injected.rules[0]?.toolPattern, "mcp__test__*");
  });
});

describe("dsh-bootstrap-plugin materialize", () => {
  beforeEach(() => resetBootstrapCacheForTests());
  const originalDegrade = process.env.DIY_BOOTSTRAP_DEV_DEGRADE;

  afterEach(() => {
    if (originalDegrade === undefined) delete process.env.DIY_BOOTSTRAP_DEV_DEGRADE;
    else process.env.DIY_BOOTSTRAP_DEV_DEGRADE = originalDegrade;
  });

  it("materializes bundle from Control Plane profile version + MCP catalog", async () => {
    const fetchImpl = async (url: string) => {
      if (url.includes("/profiles/")) {
        return new Response(
          JSON.stringify({
            snapshot: { kbConfig: { internal: { enabled: true } } },
            policy: defaultWorkspaceAccessPolicy("ws-1" as import("@diy-agent/domain").WorkspaceId),
            credentialRefIds: ["cred-1"],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/mcp/catalog")) {
        return new Response(
          JSON.stringify({
            catalog: [
              {
                serverName: "kb-search",
                tenantId: "t-1",
                transport: "stdio",
                defaultSensitivity: "readonly",
                approvalStatus: "approved",
                createdAt: new Date().toISOString(),
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const bundle = await materializeProfileBootstrapBundle({
      controlPlaneUrl: "http://cp.test",
      serviceAccountToken: "sa-token",
      profileId: "prof-1" as import("@diy-agent/domain").ProfileId,
      profileVersionId: "ver-1" as import("@diy-agent/domain").ProfileVersionId,
      workspaceId: "ws-1" as import("@diy-agent/domain").WorkspaceId,
      tenantId: "t-1" as import("@diy-agent/domain").TenantId,
      fetchImpl,
    });

    assert.equal(bundle.credentialRefIds[0], "cred-1");
    assert.equal(bundle.kbConfig?.internal?.enabled, true);
    assert.deepEqual(bundle.blockedMcpServers, []);
  });

  it("fail-fast when Control Plane pull fails", async () => {
    delete process.env.DIY_BOOTSTRAP_DEV_DEGRADE;
    await assert.rejects(
      () =>
        materializeProfileBootstrapBundle({
          controlPlaneUrl: "http://cp.test",
          profileId: "prof-1" as import("@diy-agent/domain").ProfileId,
          profileVersionId: "ver-1" as import("@diy-agent/domain").ProfileVersionId,
          workspaceId: "ws-1" as import("@diy-agent/domain").WorkspaceId,
          tenantId: "t-1" as import("@diy-agent/domain").TenantId,
          fetchImpl: async () => new Response("fail", { status: 503 }),
        }),
      /bootstrap_unavailable:profile_http_503/,
    );
  });

  it("dev degrade falls back to default bundle", async () => {
    process.env.DIY_BOOTSTRAP_DEV_DEGRADE = "true";
    const bundle = await materializeProfileBootstrapBundle({
      controlPlaneUrl: "http://cp.test",
      profileId: "prof-1" as import("@diy-agent/domain").ProfileId,
      profileVersionId: "ver-1" as import("@diy-agent/domain").ProfileVersionId,
      workspaceId: "ws-1" as import("@diy-agent/domain").WorkspaceId,
      tenantId: "t-1" as import("@diy-agent/domain").TenantId,
      fetchImpl: async () => new Response("fail", { status: 503 }),
    });
    assert.ok(bundle.policy);
  });

  it("materializes bundle from profile-sync payload", () => {
    const bundle = materializeProfileBootstrapBundleFromSync({
      profileId: "prof-1" as import("@diy-agent/domain").ProfileId,
      versionId: "ver-1" as import("@diy-agent/domain").ProfileVersionId,
      workspaceId: "ws-1" as import("@diy-agent/domain").WorkspaceId,
      tenantId: "t-1" as import("@diy-agent/domain").TenantId,
      snapshot: { kbConfig: { internal: { enabled: true } } },
      policy: defaultWorkspaceAccessPolicy("ws-1" as import("@diy-agent/domain").WorkspaceId),
      credentialRefIds: ["vault://ref-1"],
      mcpCatalog: [
        {
          serverName: "pending-srv",
          tenantId: "t-1" as import("@diy-agent/domain").TenantId,
          transport: "stdio",
          defaultSensitivity: "normal",
          approvalStatus: "pending",
          createdAt: new Date(),
        },
      ],
    });
    assert.equal(bundle.credentialRefIds[0], "vault://ref-1");
    assert.deepEqual(bundle.blockedMcpServers, ["pending-srv"]);
  });

  it("uses cached bundle when Control Plane pull fails after profile-sync materialize", async () => {
    storeProfileBootstrapBundle(
      buildProfileBootstrapBundle({
        profileId: "prof-1" as import("@diy-agent/domain").ProfileId,
        profileVersionId: "ver-1" as import("@diy-agent/domain").ProfileVersionId,
        workspaceId: "ws-1" as import("@diy-agent/domain").WorkspaceId,
        tenantId: "t-1" as import("@diy-agent/domain").TenantId,
        snapshot: { kbConfig: { internal: { enabled: true } } },
      }),
    );
    delete process.env.DIY_BOOTSTRAP_DEV_DEGRADE;

    const bundle = await materializeProfileBootstrapBundle({
      controlPlaneUrl: "http://cp.test",
      profileId: "prof-1" as import("@diy-agent/domain").ProfileId,
      profileVersionId: "ver-1" as import("@diy-agent/domain").ProfileVersionId,
      workspaceId: "ws-1" as import("@diy-agent/domain").WorkspaceId,
      tenantId: "t-1" as import("@diy-agent/domain").TenantId,
      fetchImpl: async () => new Response("fail", { status: 503 }),
    });

    assert.equal(bundle.kbConfig?.internal?.enabled, true);
  });

  it("offline mode requires cached bootstrap bundle", async () => {
    delete process.env.DIY_BOOTSTRAP_DEV_DEGRADE;
    await assert.rejects(
      () =>
        materializeProfileBootstrapBundle({
          controlPlaneUrl: "http://cp.test",
          profileId: "prof-1" as import("@diy-agent/domain").ProfileId,
          profileVersionId: "ver-1" as import("@diy-agent/domain").ProfileVersionId,
          workspaceId: "ws-1" as import("@diy-agent/domain").WorkspaceId,
          tenantId: "t-1" as import("@diy-agent/domain").TenantId,
          offline: true,
        }),
      /bootstrap_unavailable:offline_cache_miss/,
    );
  });
});

describe("dsh-bootstrap-plugin session create wrap", () => {
  beforeEach(() => resetBootstrapCacheForTests());

  it("bootstrap runs before original session create", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      if (url.includes("/profiles/")) {
        return new Response(
          JSON.stringify({
            snapshot: {},
            policy: defaultWorkspaceAccessPolicy("ws-1" as import("@diy-agent/domain").WorkspaceId),
            credentialRefIds: [],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ catalog: [] }), { status: 200 });
    };

    const ctx = {
      sessions: {
        create(id: string, opts?: { meta?: Record<string, string> }) {
          calls.push(`create:${id}`);
          return { id, meta: opts?.meta };
        },
      },
      effect(fn: () => void | (() => void)) {
        fn();
      },
    };

    apply(ctx, { controlPlaneUrl: "http://cp.test", serviceAccountToken: "sa", fetchImpl });

    await ctx.sessions.create("sess-1", {
      meta: {
        "diy.tenantId": "t-1",
        "diy.workspaceId": "ws-1",
        "diy.profileId": "prof-1",
        "diy.profileVersionId": "ver-1",
      },
    });

    assert.deepEqual(calls, ["create:sess-1"]);
    assert.ok(getWorkspacePolicy("ws-1"));
  });
});
