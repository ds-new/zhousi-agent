import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../src/memory-store.js";

describe("audit log store", () => {
  it("listAuditLog returns tenant events newest first", async () => {
    const store = new MemoryStore();
    const tenant = await store.createTenant({ name: "AuditTenant" });
    const other = await store.createTenant({ name: "OtherTenant" });

    await store.appendAudit({
      tenantId: tenant.id,
      action: "session.created",
      metadata: { sessionId: "s1" },
    });
    await store.appendAudit({
      tenantId: other.id,
      action: "session.created",
      metadata: { sessionId: "s2" },
    });
    await store.appendAudit({
      tenantId: tenant.id,
      action: "profile.pinned",
      metadata: { profileId: "p1" },
    });

    const events = await store.listAuditLog(tenant.id);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.action, "profile.pinned");
    assert.equal(events[1]!.action, "session.created");
  });
});
