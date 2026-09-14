import assert from "node:assert/strict";
import { it } from "node:test";
import { MemoryStore } from "../src/memory-store.js";

it("session bootstrap validates the token and returns only the pinned profile's bound catalogs", async () => {
  const store = new MemoryStore();
  const tenant = await store.createTenant({ name: "bootstrap", gateway: { rateLimitRpm: 2 } });
  const ws = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const skill = await store.registerSkill({ tenantId: tenant.id, workspaceId: ws.id, name: "bound", contentHash: "bound-hash", source: "private" });
  await store.registerSkill({ tenantId: tenant.id, workspaceId: ws.id, name: "unbound", contentHash: "private-hash", source: "private" });
  for (const serverName of ["tool", "knowledge", "private-server"]) await store.registerMcp({ tenantId: tenant.id, serverName, transport: "stdio", command: "echo", approvalStatus: "approved" });
  const created = (await store.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: { systemPrompt: "pinned", skillIds: [skill.id],
    mcpBindings: [{ serverName: "tool", transport: "stdio" }], kbConfig: { externalMcp: { serverName: "knowledge", transport: "stdio" } } } }))!;
  await store.pinProfile(created.profile.id, created.version.id);
  const session = (await store.createSession({ tenantId: tenant.id, profileId: created.profile.id }))!;
  assert.equal(await store.resolveSessionBootstrap(session.session.id, "invalid", true), null);
  const boot = (await store.resolveSessionBootstrap(session.session.id, session.sessionToken))!;
  assert.equal(boot.snapshot.systemPrompt, "pinned");
  assert.deepEqual(boot.skillHashes, { [skill.id]: "bound-hash" });
  assert.deepEqual(boot.mcpCatalog.map(entry => entry.serverName).sort(), ["knowledge", "tool"]);
  assert.equal(boot.quota, undefined);
  assert.equal(boot.policy?.workspaceId, ws.id);
  assert.equal((await store.resolveSessionBootstrap(session.session.id, session.sessionToken, true))?.quota?.allowed, true);
  assert.equal((await store.resolveSessionBootstrap(session.session.id, session.sessionToken, true))?.quota?.allowed, false);
});
