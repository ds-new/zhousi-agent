import type { ControlPlaneStore } from "@diy-agent/db";
import type { AgentProfile, ProfileId, ProfileVersionId, TenantId } from "@diy-agent/domain";
import { defaultWorkspaceAccessPolicy } from "@diy-agent/domain";
import { collectCredentialRefIds } from "@diy-agent/domain";
import { evaluatePinGate, validateGoldenTaskCount } from "@diy-agent/eval-harness";

type PinGateResult = ReturnType<typeof evaluatePinGate>;
import { runProfileEvaluation } from "./profile-eval.js";

export type FireWebhookFn = (
  tenantId: string,
  event: string,
  payload: Record<string, unknown>,
) => Promise<void>;

export type PinProfileResult =
  | { ok: true; profile: AgentProfile; gate: PinGateResult }
  | {
      ok: false;
      error:
        | "profile_not_found"
        | "version_not_found"
        | "version_approval_required"
        | "insufficient_golden_tasks"
        | "pin_gate_failed";
      gate?: PinGateResult;
      goldenCheck?: { ok: boolean; reason?: string };
    };

export async function attemptPinProfileVersion(
  store: ControlPlaneStore,
  input: {
    profileId: ProfileId;
    versionId: ProfileVersionId;
    tenantId: TenantId;
    fireWebhooks: FireWebhookFn;
    skipWebhookOnPinGateFailure?: boolean;
    evaluation?: NonNullable<Awaited<ReturnType<typeof runProfileEvaluation>>>;
  },
): Promise<PinProfileResult> {
  const profile = await store.getProfile(input.profileId);
  if (!profile || (await store.getWorkspace(profile.workspaceId))?.tenantId !== input.tenantId) return { ok: false, error: "profile_not_found" };
  const version = await store.getProfileVersion(input.profileId, input.versionId);
  if (!version) return { ok: false, error: "version_not_found" };
  if (version.approvalStatus !== "approved") return { ok: false, error: "version_approval_required" };

  const tasks = await store.listGoldenTasks(input.profileId);
  const goldenCheck = validateGoldenTaskCount(tasks.length);
  if (!goldenCheck.ok) {
    return { ok: false, error: "insufficient_golden_tasks", goldenCheck };
  }

  // Re-read durable evidence: caller-supplied gates may be stale or forged.
  const evaluation = await runProfileEvaluation(store, input.profileId, input.versionId);
  if (!evaluation) return { ok: false, error: "profile_not_found" };
  if (!evaluation.gate.passed) {
    if (!input.skipWebhookOnPinGateFailure) {
      await input.fireWebhooks(input.tenantId, "eval.pin_gate_failed", {
        profileId: input.profileId,
        reasons: evaluation.gate.reasons,
      });
    }
    return { ok: false, error: "pin_gate_failed", gate: evaluation.gate };
  }

  const pinned = await store.pinProfile(input.profileId, input.versionId, {
    taskSetHash: evaluation.evalRun.taskSetHash!, evalBatchId: evaluation.evalRun.evalBatchId!,
  });
  if (!pinned) return { ok: false, error: "version_not_found" };

  const pinnedVersion = await store.getProfileVersion(input.profileId, input.versionId);
  const policy =
    (await store.getWorkspacePolicy(profile.workspaceId)) ??
    defaultWorkspaceAccessPolicy(profile.workspaceId);
  const mcpCatalog = await store.listMcp(input.tenantId);
  const credentialRefIds = collectCredentialRefIds(profile);

  await store.appendAudit({
    tenantId: input.tenantId,
    workspaceId: profile.workspaceId,
    action: "profile.pinned",
    metadata: { profileId: input.profileId, versionId: input.versionId },
  });
  await input.fireWebhooks(input.tenantId, "profile.pinned", {
    profileId: input.profileId,
    versionId: input.versionId,
    workspaceId: profile.workspaceId,
    tenantId: input.tenantId,
    snapshot: pinnedVersion?.snapshot,
    pinnedAt: new Date().toISOString(),
    policy,
    credentialRefIds,
    mcpCatalog,
  });

  return { ok: true, profile: pinned, gate: evaluation.gate };
}
