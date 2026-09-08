/**
 * Knowledge Base DSH adapter — kb_search tool + shared KbRuntime.
 */
import { createKbRuntime, type KbRuntime, type KbRuntimeDeps } from "./kb-runtime.js";
import {
  handleAutoRagTurnStart,
  resetAutoRagForTests,
} from "./auto-rag.js";
import { resolveKbConfigForSession, type KbSessionContext } from "./snapshot-resolver.js";

export const name = "@diy-agent/dsh-kb-plugin";
export const inject = ["tools", "sessions"] as const;

export { createKbRuntime, resetKbRuntimeForTests, type KbRuntime, type KbRuntimeDeps } from "./kb-runtime.js";
export {
  formatAutoRagContext,
  getAutoRagContext,
  handleAutoRagTurnStart,
  resetAutoRagForTests,
  runAutoRagOnTurnStart,
  type TurnStartPayload,
} from "./auto-rag.js";
export {
  handleKbDocumentHttp,
  handleKbSearchHttp,
  validateInternalToken,
  type KbDocumentHttpBody,
  type KbSearchHttpBody,
} from "./kb-http.js";
export {
  getKbConfigFromBundle,
  resolveKbConfigFromSnapshot,
  resolveKbConfigForSession,
  type KbSessionContext,
} from "./snapshot-resolver.js";

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
  on: (event: string, handler: (...args: unknown[]) => void) => void;
}

export interface KbPluginConfig {
  runtimeDeps?: KbRuntimeDeps;
  runtime?: KbRuntime;
}

const registeredHandlers = new Map<string, (args: KbSearchToolArgs) => Promise<unknown>>();
let kbSearchToolRegistered = false;

export function getKbSearchHandler(name = "kb_search"): ((args: KbSearchToolArgs) => Promise<unknown>) | undefined {
  return registeredHandlers.get(name);
}

export function registerKbSearchTool(
  tools: ToolRegistry,
  runtime: KbRuntime,
  defaultSession?: KbSessionContext,
): void {
  if (kbSearchToolRegistered) return;

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
  kbSearchToolRegistered = true;
}

export function apply(ctx: PluginContext, config: KbPluginConfig = {}): void {
  const runtime = config.runtime ?? createKbRuntime(config.runtimeDeps);

  ctx.effect(() => {
    ctx.on("session/turn-start", (...args: unknown[]) => {
      const payload = args[0] as import("./auto-rag.js").TurnStartPayload | undefined;
      void (async () => {
        const injected = await handleAutoRagTurnStart(runtime, payload);
        if (injected) return;

        const session =
          payload?.workspaceId && payload.profileId && payload.profileVersionId
            ? ({
                workspaceId: payload.workspaceId,
                profileId: payload.profileId,
                profileVersionId: payload.profileVersionId,
                tenantId: payload.tenantId,
              } as KbSessionContext)
            : null;
        if (!session) return;

        try {
          const kbConfig = resolveKbConfigForSession(session);
          if (kbConfig.retrievalMode !== "auto") {
            registerKbSearchTool(ctx.tools, runtime);
          }
        } catch {
          // snapshot unavailable
        }
      })();
    });
  });
}

export function resetKbPluginForTests(): void {
  registeredHandlers.clear();
  kbSearchToolRegistered = false;
  resetAutoRagForTests();
}
