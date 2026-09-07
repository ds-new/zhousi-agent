/**
 * Knowledge Base DSH adapter — kb_search tool + shared KbRuntime.
 */
import type { KnowledgeBaseConfig, ProfileId, ProfileVersionId, WorkspaceId } from "@diy-agent/domain";
import { createKbRuntime, type KbRuntime, type KbRuntimeDeps } from "./kb-runtime.js";
import { resolveKbConfigForSession } from "./snapshot-resolver.js";

export const name = "@diy-agent/dsh-kb-plugin";
export const inject = ["tools"] as const;

export { createKbRuntime, resetKbRuntimeForTests, type KbRuntime, type KbRuntimeDeps } from "./kb-runtime.js";
export {
  handleKbDocumentHttp,
  handleKbSearchHttp,
  validateInternalToken,
  type KbDocumentHttpBody,
  type KbSearchHttpBody,
} from "./kb-http.js";
export { resolveKbConfigFromSnapshot, resolveKbConfigForSession } from "./snapshot-resolver.js";

export interface KbSessionContext {
  workspaceId: WorkspaceId;
  profileId: ProfileId;
  profileVersionId: ProfileVersionId;
  tenantId?: string;
  kbConfig?: KnowledgeBaseConfig;
}

export interface KbSearchToolArgs {
  query: string;
  session?: KbSessionContext;
}

interface ToolRegistry {
  register: (name: string, handler: (args: unknown) => Promise<unknown>) => void;
}

interface PluginContext {
  tools: ToolRegistry;
  effect: (fn: () => void | (() => void)) => void;
}

export interface KbPluginConfig {
  runtimeDeps?: KbRuntimeDeps;
  runtime?: KbRuntime;
}

const registeredHandlers = new Map<string, (args: KbSearchToolArgs) => Promise<unknown>>();

export function getKbSearchHandler(name = "kb_search"): ((args: KbSearchToolArgs) => Promise<unknown>) | undefined {
  return registeredHandlers.get(name);
}

export function registerKbSearchTool(
  tools: ToolRegistry,
  runtime: KbRuntime,
  defaultSession?: KbSessionContext,
): void {
  const handler = async (raw: unknown) => {
    const args = raw as KbSearchToolArgs;
    const session = args.session ?? defaultSession;
    if (!session) throw new Error("kb_session_context_required");
    if (!args.query?.trim()) throw new Error("kb_query_required");

    const kbConfig = resolveKbConfigForSession(session);
    if (kbConfig.retrievalMode === "auto") {
      throw new Error("kb_search_unavailable_in_auto_mode");
    }

    return runtime.search({
      workspaceId: session.workspaceId,
      query: args.query,
      kbConfig,
      tenantId: session.tenantId as import("@diy-agent/domain").TenantId | undefined,
    });
  };

  registeredHandlers.set("kb_search", handler);
  tools.register("kb_search", handler);
}

export function apply(ctx: PluginContext, config: KbPluginConfig = {}): void {
  const runtime = config.runtime ?? createKbRuntime(config.runtimeDeps);

  ctx.effect(() => {
    registerKbSearchTool(ctx.tools, runtime);
  });
}

export function resetKbPluginForTests(): void {
  registeredHandlers.clear();
}
