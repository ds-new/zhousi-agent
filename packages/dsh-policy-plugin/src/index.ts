/**
 * Access Policy gate — allow/deny/ask for MCP tool calls.
 */
import type { AccessPolicy, AccessPolicyRule, McpBinding } from "@diy-agent/domain";

export const name = "@diy-agent/dsh-policy-plugin";
export const inject = ["sessions"] as const;

const policies = new Map<string, AccessPolicy>();

export interface ToolCallContext {
  toolName: string;
  binding?: McpBinding;
  workspaceId?: string;
}

export interface PolicyDecision {
  effect: AccessPolicyRule["effect"];
  reason: string;
}

export function apply(ctx: {
  effect: (fn: () => void) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
}): void {
  ctx.effect(() => {
    ctx.on("tool/before-call", (...args: unknown[]) => {
      const call = args[0] as ToolCallContext | undefined;
      if (!call?.workspaceId) return;
      const decision = evaluatePolicy(call.workspaceId, call);
      if (decision.effect === "deny") {
        throw new Error(`policy_denied: ${decision.reason}`);
      }
      if (decision.effect === "ask") {
        throw new Error(`policy_ask_required: ${decision.reason}`);
      }
    });
  });
}

export function setWorkspacePolicy(policy: AccessPolicy): void {
  policies.set(policy.workspaceId, policy);
}

export function defaultTenantPolicy(workspaceId: string): AccessPolicy {
  return {
    workspaceId: workspaceId as AccessPolicy["workspaceId"],
    rules: [
      { effect: "allow", toolPattern: "*readonly*", sensitivity: "readonly" },
      { effect: "deny", toolPattern: "*", sensitivity: "high" },
      { effect: "ask", toolPattern: "*write*", sensitivity: "high" },
    ],
  };
}

export function evaluatePolicy(workspaceId: string, call: ToolCallContext): PolicyDecision {
  const policy = policies.get(workspaceId) ?? defaultTenantPolicy(workspaceId);
  const sensitivity = call.binding?.sensitivity ?? "normal";

  for (const rule of [...policy.rules].reverse()) {
    if (rule.sensitivity && rule.sensitivity !== sensitivity) continue;
    if (!matchPattern(rule.toolPattern, call.toolName)) continue;
    return { effect: rule.effect, reason: `${rule.effect}:${rule.toolPattern}` };
  }

  if (sensitivity === "high") {
    return { effect: "deny", reason: "default_deny_high" };
  }
  return { effect: "allow", reason: "default_allow" };
}

function matchPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(toolName);
}

export function resetPoliciesForTests(): void {
  policies.clear();
}
