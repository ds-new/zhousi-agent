import type { KbSearchHit } from "@diy-agent/kb-rag";
import type { KnowledgeBaseConfig, ProfileId, ProfileVersionId, WorkspaceId } from "@diy-agent/domain";
import type { KbRuntime } from "./kb-runtime.js";
import { resolveKbConfigForSession, type KbSessionContext } from "./snapshot-resolver.js";

export interface TurnStartPayload {
  sessionId?: string;
  workspaceId?: string;
  profileId?: string;
  profileVersionId?: string;
  tenantId?: string;
  userMessage?: string;
}

const autoRagContextBySession = new Map<string, string>();

export function resetAutoRagForTests(): void {
  autoRagContextBySession.clear();
}

export function getAutoRagContext(sessionId: string): string | undefined {
  return autoRagContextBySession.get(sessionId);
}

export function formatAutoRagContext(hits: KbSearchHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map(
    (hit, index) => `[${index + 1}] ${hit.title}: ${hit.snippet} (score=${hit.score.toFixed(3)})`,
  );
  return `Relevant knowledge base excerpts:\n${lines.join("\n")}`;
}

export function sessionContextFromTurnStart(payload: TurnStartPayload): KbSessionContext | null {
  if (!payload.workspaceId || !payload.profileId || !payload.profileVersionId) return null;
  return {
    workspaceId: payload.workspaceId as WorkspaceId,
    profileId: payload.profileId as ProfileId,
    profileVersionId: payload.profileVersionId as ProfileVersionId,
    tenantId: payload.tenantId,
  };
}

export async function runAutoRagOnTurnStart(
  runtime: KbRuntime,
  payload: TurnStartPayload,
  kbConfig: KnowledgeBaseConfig,
): Promise<string | null> {
  const query = payload.userMessage?.trim();
  if (!query || !payload.sessionId || !payload.workspaceId) return null;

  const result = await runtime.search({
    workspaceId: payload.workspaceId as WorkspaceId,
    query,
    kbConfig,
    tenantId: payload.tenantId as import("@diy-agent/domain").TenantId | undefined,
  });

  const context = formatAutoRagContext(result.hits.slice(0, 3));
  if (context) autoRagContextBySession.set(payload.sessionId, context);
  return context || null;
}

export async function handleAutoRagTurnStart(
  runtime: KbRuntime,
  payload: TurnStartPayload | undefined,
): Promise<string | null> {
  if (!payload) return null;
  const session = sessionContextFromTurnStart(payload);
  if (!session) return null;

  let kbConfig: KnowledgeBaseConfig;
  try {
    kbConfig = resolveKbConfigForSession(session);
  } catch {
    return null;
  }

  if (kbConfig.retrievalMode !== "auto") return null;
  return runAutoRagOnTurnStart(runtime, payload, kbConfig);
}
