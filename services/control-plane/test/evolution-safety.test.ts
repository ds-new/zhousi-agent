import assert from "node:assert/strict";
import { it } from "node:test";
import { MemoryStore } from "@diy-agent/db";

async function separateTenantEvolutionRuns() {
  const store = new MemoryStore();
  const a = await store.createTenant({ name: "Evolution A" });
  const b = await store.createTenant({ name: "Evolution B" });
  const wsA = (await store.createWorkspace({ tenantId: a.id }))!;
  const wsB = (await store.createWorkspace({ tenantId: b.id }))!;
  const own = (await store.createProfile({ tenantId: a.id, workspaceId: wsA.id, profile: {} }))!;
  const foreign = (await store.createProfile({ tenantId: b.id, workspaceId: wsB.id, profile: {} }))!;
  const runA = (await store.createEvolutionRun({ tenantId: a.id, profileId: own.profile.id, tier: "L2", trigger: "manual" }))!;
  const runB = (await store.createEvolutionRun({ tenantId: b.id, profileId: foreign.profile.id, tier: "L2", trigger: "manual" }))!;
  const candidateB = (await store.finalizeEvolutionFromService({ tenantId: b.id, runId: runB.id, status: "awaiting_review" }))!;
  assert.ok(candidateB.candidateVersionId);
  return { store, a, own, foreign, runA, foreignCandidateId: candidateB.candidateVersionId };
}

it("requires L2 review for system prompt mutation even when labelled L1", async () => {
  const store = new MemoryStore();
  const tenant = await store.createTenant({ name: "governance" });
  const ws = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const { profile } = (await store.createProfile({ tenantId: tenant.id, workspaceId: ws.id, profile: {} }))!;
  const run = (await store.createEvolutionRun({ tenantId: tenant.id, profileId: profile.id, target: "prompt", tier: "L1", trigger: "manual" }))!;
  const finalized = (await store.finalizeEvolutionFromService({ tenantId: tenant.id, runId: run.id, status: "completed",
    mutations: [{ path: "prompt/system", before: profile.systemPrompt, after: "changed behavior", tier: "L1" }] }))!;
  assert.equal(finalized.status, "awaiting_review");
});

it("rejects approval that explicitly references another tenant's candidate version", async () => {
  const { store, a, foreign, runA, foreignCandidateId } = await separateTenantEvolutionRuns();

  const approved = await store.approveEvolutionRun({ tenantId: a.id, runId: runA.id, reviewer: "admin-a", candidateVersionId: foreignCandidateId });

  assert.equal(approved, null);
  assert.equal((await store.getEvolutionRun(runA.id))?.status, "awaiting_review");
  assert.equal((await store.getProfileVersion(foreign.profile.id, foreignCandidateId))?.approvalStatus, "pending");
});

it("rejects finalization that attaches another tenant's candidate version", async () => {
  const { store, a, foreign, runA, foreignCandidateId } = await separateTenantEvolutionRuns();

  const finalized = await store.finalizeEvolutionFromService({ tenantId: a.id, runId: runA.id, status: "completed", candidateVersionId: foreignCandidateId });

  assert.equal(finalized, null);
  assert.equal((await store.getEvolutionRun(runA.id))?.candidateVersionId, undefined);
  assert.equal((await store.getProfileVersion(foreign.profile.id, foreignCandidateId))?.approvalStatus, "pending");
});

it("cannot approve another tenant's candidate by omitting its ID after finalization", async () => {
  const { store, a, foreign, runA, foreignCandidateId } = await separateTenantEvolutionRuns();

  const finalized = await store.finalizeEvolutionFromService({ tenantId: a.id, runId: runA.id, status: "awaiting_review", candidateVersionId: foreignCandidateId });
  if (finalized) {
    const approved = await store.approveEvolutionRun({ tenantId: a.id, runId: runA.id, reviewer: "admin-a" });
    assert.equal(approved, null);
  } else {
    assert.equal((await store.getEvolutionRun(runA.id))?.candidateVersionId, undefined);
  }

  assert.equal((await store.getProfileVersion(foreign.profile.id, foreignCandidateId))?.approvalStatus, "pending");
});

it("does not allow pinning an L2 candidate before its pending review is approved", async () => {
  const store = new MemoryStore();
  const tenant = await store.createTenant({ name: "Pending review" });
  const workspace = (await store.createWorkspace({ tenantId: tenant.id }))!;
  const { profile, version } = (await store.createProfile({ tenantId: tenant.id, workspaceId: workspace.id, profile: {} }))!;
  assert.ok(await store.pinProfile(profile.id, version.id));
  const run = (await store.createEvolutionRun({ tenantId: tenant.id, profileId: profile.id, tier: "L2", target: "prompt", trigger: "manual" }))!;
  const finalized = (await store.finalizeEvolutionFromService({ tenantId: tenant.id, runId: run.id, status: "completed",
    mutations: [{ path: "prompt/system", before: profile.systemPrompt, after: "Unreviewed behavior", tier: "L2" }] }))!;
  assert.ok(finalized.candidateVersionId);
  assert.equal((await store.getProfileVersion(profile.id, finalized.candidateVersionId))?.approvalStatus, "pending");

  const pinned = await store.pinProfile(profile.id, finalized.candidateVersionId);

  assert.equal(pinned, null);
  assert.equal((await store.getProfile(profile.id))?.pinnedVersionId, version.id);
});
