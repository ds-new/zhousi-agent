import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { McpBinding } from "@diy-agent/domain";
import { acquire, apply, poolKey, release, resetPoolForTests } from "../src/index.js";

const binding: McpBinding = { serverName: "knowledge", transport: "stdio", command: "mcp-server" };
const context = { tenantId: "tenant-a", workspaceId: "workspace-shared", sessionId: "session-shared" };

describe("MCP pool isolation and quota regressions", () => {
  beforeEach(() => {
    resetPoolForTests();
    apply({}, { warmPoolDefault: true, idleTimeoutMs: 60_000, maxConnectionsPerTenant: 10 });
  });
  afterEach(() => resetPoolForTests());

  for (const poolScope of ["workspace", "session"] as const) {
    it(`does not share ${poolScope} connections across tenants with identical local IDs`, () => {
      const scoped = { ...binding, poolScope };

      const first = acquire(scoped, context);
      const second = acquire(scoped, { ...context, tenantId: "tenant-b" });

      assert.notEqual(first.handle, second.handle);
    });
  }

  it("separates connections with different launch arguments", () => {
    const first = { ...binding, args: ["--database", "customers"] };
    const second = { ...binding, args: ["--database", "payroll"] };

    assert.notEqual(poolKey(first, context), poolKey(second, context));
    assert.notEqual(acquire(first, context).handle, acquire(second, context).handle);
  });

  it("separates connections using different credential references", () => {
    const first = { ...binding, envRef: { API_KEY: "vault/customer-reader" } };
    const second = { ...binding, envRef: { API_KEY: "vault/payroll-admin" } };

    assert.notEqual(poolKey(first, context), poolKey(second, context));
    assert.notEqual(acquire(first, context).handle, acquire(second, context).handle);
  });

  it("rejects acquire without a tenant identity", () => {
    assert.throws(() => acquire(binding, { workspaceId: "workspace-shared" }));
  });

  for (const poolScope of ["workspace", "session"] as const) {
    it(`rejects acquire without the required ${poolScope} identity`, () => {
      assert.throws(() => acquire({ ...binding, poolScope }, { tenantId: "tenant-a" }));
    });
  }

  it("rejects an empty tenant identity", () => {
    assert.throws(() => acquire({ ...binding, poolScope: "tenant" }, { tenantId: "" }));
  });

  for (const poolScope of ["tenant", "workspace", "session"] as const) {
    it(`enforces the tenant quota for ${poolScope} connections while permitting reuse`, () => {
      apply({}, { warmPoolDefault: true, idleTimeoutMs: 60_000, maxConnectionsPerTenant: 1 });
      const scoped = { ...binding, poolScope };
      const existing = acquire(scoped, context);

      assert.equal(acquire(scoped, context).handle, existing.handle, "a full pool must still reuse an existing connection");
      assert.throws(
        () => acquire({ ...scoped, serverName: "second-server" }, context),
        /mcp_warm_pool_limit_exceeded/,
      );
      assert.doesNotThrow(() => acquire(scoped, { ...context, tenantId: "tenant-b" }), "another tenant retains its own quota");
    });
  }

  it("prevents explicit tenant scope from weakening high-sensitivity session isolation", () => {
    const sensitive: McpBinding = { ...binding, sensitivity: "high", poolScope: "tenant", warmPool: true };

    assert.notEqual(
      poolKey(sensitive, { ...context, sessionId: "session-first" }),
      poolKey(sensitive, { ...context, sessionId: "session-second" }),
    );
  });

  it("does not let one tenant release another tenant's warm connection", () => {
    const existing = acquire(binding, context);

    release({ ...binding, warmPool: false }, { ...context, tenantId: "tenant-b" });

    assert.equal(acquire(binding, context).handle, existing.handle);
  });
});
