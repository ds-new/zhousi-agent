import type { IncomingMessage } from "node:http";
import type { KnowledgeBaseConfig, ProfileId, TenantId, WorkspaceId } from "@diy-agent/domain";
import type { KbRuntime } from "./kb-runtime.js";

export function validateInternalToken(
  req: IncomingMessage,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return true;
  const header = req.headers.authorization;
  return header === `Bearer ${expectedToken}`;
}

export interface KbSearchHttpBody {
  profileId?: ProfileId;
  workspaceId?: WorkspaceId;
  tenantId?: TenantId;
  query?: string;
  kbConfig?: KnowledgeBaseConfig;
}

export interface KbDocumentHttpBody {
  profileId?: ProfileId;
  workspaceId?: WorkspaceId;
  tenantId?: TenantId;
  title?: string;
  content?: string;
  kbConfig?: KnowledgeBaseConfig;
}

export async function handleKbSearchHttp(
  runtime: KbRuntime,
  body: KbSearchHttpBody,
): Promise<{ status: number; body: unknown }> {
  if (!body.workspaceId || !body.query) {
    return { status: 400, body: { error: "missing_fields" } };
  }

  const kbConfig = body.kbConfig ?? { internal: { enabled: true } };

  try {
    const result = await runtime.search({
      workspaceId: body.workspaceId as WorkspaceId,
      query: body.query,
      kbConfig,
      tenantId: body.tenantId as TenantId | undefined,
    });
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof Error && err.message === "kb_config_unavailable") {
      return { status: 503, body: { error: "kb_config_unavailable" } };
    }
    throw err;
  }
}

export async function handleKbDocumentHttp(
  runtime: KbRuntime,
  body: KbDocumentHttpBody,
): Promise<{ status: number; body: unknown }> {
  if (!body.workspaceId || !body.title || !body.content) {
    return { status: 400, body: { error: "missing_fields" } };
  }

  const kbConfig = body.kbConfig ?? { internal: { enabled: true } };
  const doc = await runtime.ingest({
    workspaceId: body.workspaceId as WorkspaceId,
    title: body.title,
    content: body.content,
    kbConfig,
    tenantId: body.tenantId as TenantId | undefined,
  });

  if (!doc) return { status: 400, body: { error: "internal_kb_disabled" } };
  return { status: 201, body: doc };
}
