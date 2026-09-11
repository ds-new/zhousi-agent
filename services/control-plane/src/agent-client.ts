import type { ControlPlaneStore } from "@diy-agent/db";
import type { AgentGoldenTaskRunner } from "./golden-task-runner.js";
import type { TenantServiceRoute } from "./tenant-routing.js";

export function createDataPlaneAgentRunner(store: ControlPlaneStore, options: { url?: string; token?: string; routes?:Record<string,TenantServiceRoute>; fetchImpl?: typeof fetch }): AgentGoldenTaskRunner {
  return async (task, snapshot) => {
    const tenant = await store.getTenantForProfile(snapshot.id);
    if (!tenant) throw new Error("agent_tenant_not_found");
    const url=options.routes ? options.routes[tenant.id]?.dataPlaneUrl : options.url;
    const token=options.routes ? options.routes[tenant.id]?.dataPlaneToken : options.token;
    if(!url||!token)throw new Error("agent_runner_not_configured");
    if(!(await store.checkSessionQuota(tenant.id)).allowed)throw new Error("tenant_quota_exceeded");
    const catalog = await store.listMcp(tenant.id);
    const skills = await store.listSkills(tenant.id, snapshot.workspaceId);
    const skillHashes = Object.fromEntries(skills.map(skill => [skill.id, skill.contentHash]));
    const policy = await store.getWorkspacePolicy(snapshot.workspaceId);
    const res = await (options.fetchImpl ?? fetch)(`${url.replace(/\/$/, "")}/agent/run`, {
      method: "POST", signal: AbortSignal.timeout(300_000), redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      // Deliberately exclude the scoring rubric and expectedContains from execution.
      body: JSON.stringify({ input: task.input, snapshot, tenantId: tenant.id, workspaceId: snapshot.workspaceId,
        sessionId: crypto.randomUUID(), profileVersionId: "evaluation", ephemeral: true, policy, mcpCatalog: catalog, skillHashes }),
    });
    if (!res.ok) throw new Error(`agent_execution_http_${res.status}`);
    const result = await res.json();
    if (typeof result.output !== "string" || !Number.isFinite(result.latencyMs) || result.latencyMs < 0) throw new Error("agent_invalid_trace");
    if(Number.isSafeInteger(result.tokensUsed)&&result.tokensUsed>=0)await store.recordUsageOnce(tenant.id,crypto.randomUUID(),result.tokensUsed);
    return result;
  };
}
