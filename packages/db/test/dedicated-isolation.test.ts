import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Tenant } from "@diy-agent/domain";
import {
  buildDedicatedConnectionString,
  dedicatedDatabaseName,
  resolveTenantStorageTarget,
} from "../src/tenant-storage.js";

describe("dedicated tenant storage", () => {
  it("resolveTenantStorageTarget maps dedicated mode to public schema", () => {
    const tenant = {
      id: "t-1",
      dbSchema: "tenant_t1",
      isolationMode: "dedicated",
    } as Tenant;
    assert.deepEqual(resolveTenantStorageTarget(tenant), {
      schema: "public",
      dedicated: true,
    });
  });

  it("resolveTenantStorageTarget uses tenant schema for standard mode", () => {
    const tenant = {
      id: "t-2",
      dbSchema: "tenant_t2",
      isolationMode: "schema",
    } as Tenant;
    assert.deepEqual(resolveTenantStorageTarget(tenant), {
      schema: "tenant_t2",
      dedicated: false,
    });
  });

  it("builds dedicated database name and connection string", () => {
    const dbName = dedicatedDatabaseName("abcd-1234-5678-90ab-cdef");
    assert.match(dbName, /^diy_t_abcd1234567890ab$/);
    const url = buildDedicatedConnectionString("postgres://diy:diy@localhost:5432/diy_agent", dbName);
    assert.equal(url, "postgres://diy:diy@localhost:5432/diy_t_abcd1234567890ab");
  });
});
