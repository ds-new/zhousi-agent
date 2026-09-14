import { createDataPlaneAgentRunner } from "./agent-client.js";
import { evaluateMultiAgent } from "./multi-agent-eval.js";
import { runEvolutionCycle } from "./evolution-cycle.js";
import { readTenantServices,type TenantServiceRoute } from "./tenant-routing.js";
import { runGoldenTaskAgentEval } from "./golden-task-runner.js";
import { readBody } from "./request-body.js";
import { authorizeRoute } from "./route-authorization.js";
/**
 * Control Plane HTTP server — testable factory + route handlers.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createOrchestrator } from "@diy-agent/orchestrator";
import {
  MemoryStore,
  createStore,
  type ControlPlaneStore,
  type QuotaCheckResult,
} from "@diy-agent/db";
import type { AgentProfile, GovernanceTier, ProfileId, TenantId } from "@diy-agent/domain";
import {
  DEFAULT_EVOLUTION_SIGNAL_THRESHOLD,
  collectCredentialRefIds,
  defaultWorkspaceAccessPolicy,
} from "@diy-agent/domain";
import { invokeEvolutionService } from "./evolution-client.js";
import { dispatchWebhooks, type WebhookFetch } from "./webhook-dispatcher.js";
import {
  requireAuth,
  requirePlatformAdmin,
  requireServiceAccount,
  requireWorkspacePermission,
  type AuthMode,
  type ServiceAccountMode,
} from "./auth-middleware.js";
import { runProfileEvaluation } from "./profile-eval.js";
import { attemptPinProfileVersion } from "./profile-pin.js";
import { tryAutoPinAfterEvolution } from "./evolution-closure.js";
import { emitEvolutionApproved } from "./evolution-events.js";
import { executeEvolutionPipeline } from "./evolution-orchestrator.js";
import type { AgentGoldenTaskRunner } from "./golden-task-runner.js";
import { proxyKbDocumentIngest, proxyKbSearch, type DataPlaneFetch } from "./kb-proxy.js";
import { buildKbIngestResponse, computeKbContentHash } from "./kb-registry.js";
import type { JwksOidcConfig } from "@diy-agent/auth";

export interface ControlPlaneServer {
  server: ReturnType<typeof createServer>;
  store: ControlPlaneStore;
  baseUrl: string;
  close: () => Promise<void>;
}

export interface CreateControlPlaneOptions {
  allowDevOidc?: boolean;
  store?: ControlPlaneStore;
  port?: number;
  storage?: "memory" | "postgres";
  evolutionInvoker?: typeof invokeEvolutionService;
  agentGoldenTaskRunner?: AgentGoldenTaskRunner;
  webhookFetch?: WebhookFetch;
  webhookAllowedOrigins?: string[];
  authMode?: AuthMode;
  serviceAccountMode?: ServiceAccountMode;
  serviceAccountToken?: string;
  serviceAccountTenantTokens?: Record<string,string>;
  tenantServices?:Record<string,TenantServiceRoute>;
  platformAdminKey?: string;
  jwksOidc?: JwksOidcConfig;
  dataPlaneUrl?: string;
  dataPlaneInternalToken?: string;
  dataPlaneFetch?: DataPlaneFetch;
  evolutionIntervalMs?: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function maybeDispatchQuotaWarning(
  store: ControlPlaneStore,
  tenantId: string,
  quota: QuotaCheckResult,
  fetchImpl: WebhookFetch,
  allowedOrigins?: string[],
): Promise<void> {
  if (!quota.warning) return;
  if (!(await store.consumeQuotaWarningDispatch(tenantId as TenantId))) return;
  await dispatchWebhooks(
    store,
    tenantId,
    "quota.warning",
    { tokensUsedToday: quota.tokensUsedToday },
    fetchImpl,
    {allowedOrigins},
  );
}

export function createControlPlaneServer(
  options: CreateControlPlaneOptions = {},
): ControlPlaneServer {
  const store = options.store ?? new MemoryStore();
  const storage = options.storage ?? "memory";
  const evolve = options.evolutionInvoker ?? invokeEvolutionService;
  const agentRunner = options.agentGoldenTaskRunner ?? createDataPlaneAgentRunner(store, { routes:options.tenantServices,url: options.dataPlaneUrl ?? process.env.DIY_DATA_PLANE_URL, token: options.dataPlaneInternalToken ?? process.env.DIY_DATA_PLANE_INTERNAL_TOKEN });
  const webhookFetch = options.webhookFetch ?? globalThis.fetch.bind(globalThis);
  const authOptions = {
    mode: options.authMode ?? ("none" as AuthMode),
    jwksOidc: options.jwksOidc,
    allowDevOidc: options.allowDevOidc,
  };
  const serviceAccountOptions = {
    mode: options.serviceAccountMode ?? ("none" as ServiceAccountMode),
    token: options.serviceAccountToken,
    tenantTokens: options.serviceAccountTenantTokens,
  };
  const platformAdminKey = options.platformAdminKey;
  const kbProxyOptions = {
    routes:options.tenantServices,
    dataPlaneUrl: options.dataPlaneUrl,
    dataPlaneInternalToken: options.dataPlaneInternalToken,
    fetchImpl: options.dataPlaneFetch,
  };

  async function fireWebhooks(
    tenantId: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await dispatchWebhooks(store, tenantId, event, payload, webhookFetch,{allowedOrigins:options.webhookAllowedOrigins});
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
  ): Promise<void> {
    if (method === "GET" && path === "/health") {
      return json(res, 200, { ok: true, storage, phase: 3 });
    }
    if (method === "GET" && path === "/ready") {
      if (closing) return json(res,503,{ok:false});
      try {await store.health();} catch {return json(res,503,{ok:false});}
      return json(res,200,{ok:true,storage});
    }

    if (method === "POST" && path === "/sessions/resolve") {
      const body = await readBody(req);
      const context=await store.resolveSessionBootstrap(String(body.sessionId??""),req.headers.authorization?.replace(/^Bearer /,"")??"",body.checkQuota===true);
      if(!context)return json(res,401,{error:"invalid_session_token"});
      return json(res,200,context);
    }

    if (method === "POST" && path === "/tenants") {
      const body = await readBody(req);
      const tenant = await store.createTenant({
        name: (body.name as string) ?? "unnamed",
        dbSchema: body.dbSchema as string | undefined,
        isolationMode: body.isolationMode as import("@diy-agent/domain").IsolationMode | undefined,
        gateway: body.gateway as import("@diy-agent/domain").TenantGateway | undefined,
      });
      const { dedicatedDatabaseUrl: _privateUrl, ...publicTenant } = tenant;
      return json(res, 201, publicTenant);
    }

    const gatewayMatch = path.match(/^\/tenants\/([^/]+)\/gateway$/);
    if (method === "PUT" && gatewayMatch) {
      const body = await readBody(req);
      const updated = await store.updateTenantGateway(
        gatewayMatch[1]! as import("@diy-agent/domain").Tenant["id"],
        body as unknown as import("@diy-agent/domain").TenantGateway,
      );
      if (!updated) return json(res, 404, { error: "tenant_not_found" });
      return json(res, 200, updated);
    }

    if (method === "POST" && path === "/workspaces") {
      const body = await readBody(req);
      if (!body.tenantId) return json(res, 400, { error: "missing_tenant_id" });
      const auth = await requireAuth(
        req,
        res,
        store,
        authOptions,
        body.tenantId as TenantId,
      );
      if (!auth) return;
      const ws = await store.createWorkspace({
        tenantId: body.tenantId as import("@diy-agent/domain").Tenant["id"],
        name: body.name as string | undefined,
        creatorUserId: body.creatorUserId as string | undefined,
      });
      if (!ws) return json(res, 400, { error: "invalid_tenant" });
      return json(res, 201, ws);
    }

    if (method === "POST" && path === "/profiles") {
      const body = await readBody(req);
      if (!body.workspaceId || !body.tenantId) {
        return json(res, 400, { error: "missing_workspace_or_tenant" });
      }
      const auth = await requireAuth(
        req,
        res,
        store,
        authOptions,
        body.tenantId as TenantId,
      );
      if (!auth) return;
      const allowed = await requireWorkspacePermission(
        store,
        res,
        auth,
        authOptions,
        body.workspaceId as import("@diy-agent/domain").WorkspaceId,
        "profile.create",
      );
      if (!allowed) return;
      try {
        const result = await store.createProfile({
          workspaceId: body.workspaceId as import("@diy-agent/domain").Workspace["id"],
          tenantId: body.tenantId as import("@diy-agent/domain").Tenant["id"],
          profile: body as Partial<AgentProfile>,
        });
        if (!result) return json(res, 400, { error: "invalid_workspace" });
        return json(res, 201, result);
      } catch (err) {
        if (err instanceof Error && err.message === "model_provider_not_allowed") {
          return json(res, 403, { error: "model_provider_not_allowed" });
        }
        throw err;
      }
    }

    const profileVersionMatch = path.match(/^\/profiles\/([^/]+)\/versions\/([^/]+)$/);
    if (method === "GET" && profileVersionMatch) {
      if (!requireServiceAccount(req, res, serviceAccountOptions)) return;
      const version = await store.getProfileVersion(
        profileVersionMatch[1] as ProfileId,
        profileVersionMatch[2]! as import("@diy-agent/domain").ProfileVersionId,
      );
      if (!version) return json(res, 404, { error: "version_not_found" });
      const profile = await store.getProfile(profileVersionMatch[1] as ProfileId);
      const policy =
        profile &&
        ((await store.getWorkspacePolicy(profile.workspaceId)) ??
          defaultWorkspaceAccessPolicy(profile.workspaceId));
      return json(res, 200, {
        ...version,
        policy: policy ?? undefined,
        credentialRefIds: profile ? collectCredentialRefIds(profile) : [],
      });
    }

    const evalRunMatch = path.match(/^\/profiles\/([^/]+)\/eval\/run$/);
    if (method === "POST" && evalRunMatch) {
      const body = await readBody(req);
      const profileId = evalRunMatch[1] as ProfileId;
      const profile = await store.getProfile(profileId);
      if (!profile) return json(res, 404, { error: "profile_not_found" });
      const versionId =
        (body.versionId as import("@diy-agent/domain").ProfileVersionId | undefined) ??
        profile.pinnedVersionId ??
        (await store.getLatestProfileVersion(profileId))?.id;
      if (!versionId) return json(res, 404, { error: "version_not_found" });
      if (body.execute === true) {
        const version = await store.getProfileVersion(profileId, versionId);
        if (!version) return json(res, 404, { error: "version_not_found" });
        await runGoldenTaskAgentEval(store, { profileId, profileVersionId: versionId, snapshot: version.snapshot, agentRunner });
      }
      const evaluation = await runProfileEvaluation(store, profileId, versionId);
      if (!evaluation) return json(res, 404, { error: "profile_not_found" });

      let evolutionRun: import("@diy-agent/domain").EvolutionRun | undefined;
      let evolutionClosure: Awaited<ReturnType<typeof tryAutoPinAfterEvolution>> | undefined;
      const tenant = await store.getTenantForProfile(profileId);
      const tenantId = (body.tenantId as TenantId | undefined) ?? tenant?.id;
      if (
        tenantId &&
        !evaluation.gate.passed &&
        evaluation.gate.passRate < DEFAULT_EVOLUTION_SIGNAL_THRESHOLD
      ) {
        const signalResult = await store.triggerEvolutionSignal({
          profileId,
          tenantId,
          passRate: evaluation.gate.passRate,
        });
        if (signalResult && !("skipped" in signalResult)) {
          try {
            const pipeline = await executeEvolutionPipeline(
              store,
              signalResult,
              tenantId,
              evolve,
              agentRunner,
            );
            if (pipeline?.awaitingReview) {
              await fireWebhooks(tenantId, "evolution.awaiting_review", {
                runId: pipeline.run.id,
              });
            }
            evolutionRun = pipeline?.run;
            if (evolutionRun) {
              evolutionClosure = await tryAutoPinAfterEvolution(store, {
                profileId,
                tenantId,
                evolutionRun,
                fireWebhooks,
                agentRunner,
              });
            }
          } catch (err) {
            if (
              !(err instanceof Error && err.message === "evolution_service_unavailable")
            ) {
              throw err;
            }
          }
        }
      }

      return json(res, 200, {
        results: evaluation.results,
        gate: evaluation.gate,
        evalRun: evaluation.evalRun,
        evolutionRun,
        postEvolutionEval: evolutionClosure?.postEvolutionEval,
        autoPin: evolutionClosure?.pin,
      });
    }

    const evalRunsMatch = path.match(/^\/profiles\/([^/]+)\/eval\/runs$/);
    if (method === "GET" && evalRunsMatch) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : 20;
      const runs = await store.listProfileEvalRuns(evalRunsMatch[1] as ProfileId, limit);
      return json(res, 200, { runs });
    }

    const multiEval = path.match(/^\/profiles\/([^/]+)\/multi-agent\/eval$/);
    if (method === "POST" && multiEval) {
      try { return json(res, 200, await evaluateMultiAgent(store, multiEval[1] as ProfileId, agentRunner)); }
      catch (error) {
        if (error instanceof Error && error.message === "worker_workspace_mismatch") return json(res, 403, { error: error.message });
        if (error instanceof Error && error.message === "requires_5_to_100_golden_tasks") return json(res, 400, { error: error.message });
        throw error;
      }
    }

    const pinMatch = path.match(/^\/profiles\/([^/]+)\/pin$/);
    if (method === "POST" && pinMatch) {
      const body = await readBody(req);
      const profileId = pinMatch[1] as ProfileId;
      const profile = await store.getProfile(profileId);
      if (!profile) return json(res, 404, { error: "profile_not_found" });

      const versionId =
        (body.versionId as import("@diy-agent/domain").ProfileVersionId | undefined) ??
        profile.pinnedVersionId ??
        (await store.getLatestProfileVersion(profileId))?.id;
      if (!versionId) return json(res, 404, { error: "version_not_found" });

      const tenantId = body.tenantId as TenantId;
      const pinResult = await attemptPinProfileVersion(store, {
        profileId,
        versionId,
        tenantId,
        fireWebhooks,
      });
      if (!pinResult.ok) {
        if (pinResult.error === "version_approval_required") return json(res, 403, { error: pinResult.error });
        if (pinResult.error === "insufficient_golden_tasks") {
          return json(res, 400, { error: pinResult.goldenCheck?.reason });
        }
        if (pinResult.error === "pin_gate_failed") {
          return json(res, 403, { error: "pin_gate_failed", gate: pinResult.gate });
        }
        return json(res, 404, { error: pinResult.error });
      }
      return json(res, 200, { profile: pinResult.profile, gate: pinResult.gate });
    }

    const profileSyncMatch = path.match(/^\/tenants\/([^/]+)\/profile-sync$/);
    if (method === "GET" && profileSyncMatch) {
      if (!requireServiceAccount(req, res, serviceAccountOptions)) return;
      const tenantId = profileSyncMatch[1] as TenantId;
      const tenant = await store.getTenant(tenantId);
      if (!tenant) return json(res, 404, { error: "tenant_not_found" });
      const profiles = await store.listProfileSyncEntries(tenantId);
      return json(res, 200, { tenantId, profiles });
    }

    if (method === "POST" && path === "/sessions") {
      const body = await readBody(req);
      if (!body.profileId || !body.tenantId) {
        return json(res, 400, { error: "missing_profile_or_tenant" });
      }
      const quota = await store.checkSessionQuota(
        body.tenantId as import("@diy-agent/domain").Tenant["id"],
      );
      if (!quota.allowed) {
        return json(res, 429, { error: quota.reason, quota });
      }
      const result = await store.createSession({
        profileId: body.profileId as ProfileId,
        tenantId: body.tenantId as import("@diy-agent/domain").Tenant["id"],
      });
      if (!result) return json(res, 400, { error: "invalid_profile" });
      await maybeDispatchQuotaWarning(
        store,
        body.tenantId as string,
        quota,
        webhookFetch,
        options.webhookAllowedOrigins,
      );
      return json(res, 201, { ...result, quotaWarning: quota.warning ?? false });
    }

    if (method === "POST" && path === "/golden-tasks") {
      const body = await readBody(req);
      if (!body.profileId || !body.input) return json(res, 400, { error: "missing_fields" });
      if (body.split !== undefined && body.split !== "train" && body.split !== "holdout") return json(res, 400, { error: "invalid_task_split" });
      const task = await store.createGoldenTask({
        profileId: body.profileId as ProfileId,
        input: body.input as string,
        expectedContains: body.expectedContains as string[] | undefined,
        maxLatencyMs: body.maxLatencyMs as number | undefined,
        split: body.split as "train" | "holdout" | undefined,
      });
      return json(res, 201, task);
    }

    const goldenListMatch = path.match(/^\/profiles\/([^/]+)\/golden-tasks$/);
    if (method === "GET" && goldenListMatch) {
      const tasks = await store.listGoldenTasks(goldenListMatch[1] as ProfileId);
      return json(res, 200, { tasks });
    }

    const tracesListMatch = path.match(/^\/profiles\/([^/]+)\/traces$/);
    if (method === "GET" && tracesListMatch) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : 50;
      const traces = await store.listTraces(tracesListMatch[1] as ProfileId, limit);
      return json(res, 200, { traces });
    }

    if (method === "POST" && path === "/usage/events") {
      const body = await readBody(req);
      if (typeof body.eventId !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(body.eventId) || !Number.isSafeInteger(body.tokensUsed) || Number(body.tokensUsed) < 0) return json(res,400,{error:"invalid_usage_event"});
      const owner = await store.getTenantForProfile(body.profileId as ProfileId);
      const version = await store.getProfileVersion(body.profileId as ProfileId,body.profileVersionId as never);
      if (!owner || !version) return json(res,404,{error:"profile_version_not_found"});
      if (body.tenantId !== owner.id) return json(res,403,{error:"tenant_mismatch"});
      const result = await store.recordUsageOnce(owner.id,body.eventId,Number(body.tokensUsed));
      await maybeDispatchQuotaWarning(store,owner.id,result.quota,webhookFetch,options.webhookAllowedOrigins);
      return json(res,result.duplicate ? 200 : 201,result);
    }

    if (method === "POST" && path === "/traces") {
      if (!requireServiceAccount(req, res, serviceAccountOptions)) return;
      const body = await readBody(req);
      if (!body.profileId || !body.profileVersionId || body.latencyMs === undefined) {
        return json(res, 400, { error: "missing_fields" });
      }
      if (!Number.isFinite(body.latencyMs) || Number(body.latencyMs) < 0 || (body.tokensUsed !== undefined && (!Number.isSafeInteger(body.tokensUsed) || Number(body.tokensUsed) < 0))) return json(res,400,{error:"invalid_trace_metrics"});
      const owner = await store.getTenantForProfile(body.profileId as ProfileId);
      if (!owner || !await store.getProfileVersion(body.profileId as ProfileId,body.profileVersionId as never)) return json(res,404,{error:"profile_version_not_found"});
      if (body.tenantId && body.tenantId !== owner.id) return json(res,403,{error:"tenant_mismatch"});
      const trace = await store.saveTrace({
        profileId: body.profileId as ProfileId,
        profileVersionId: body.profileVersionId as import("@diy-agent/domain").ProfileVersionId,
        output: (body.output as string) ?? "",
        latencyMs: body.latencyMs as number,
        toolCalls: body.toolCalls as Array<{ name: string; ok: boolean }> | undefined,
        tokensUsed: body.tokensUsed as number | undefined,
      });
      const profile = await store.getProfile(body.profileId as ProfileId);
      if (profile) {
        const ws = await store.getProfile(profile.id);
        void ws;
      }
      if (body.tokensUsed && body.tenantId) {
        const quota = await store.recordTokenUsage(
          body.tenantId as import("@diy-agent/domain").Tenant["id"],
          body.tokensUsed as number,
        );
        await maybeDispatchQuotaWarning(
          store,
          body.tenantId as string,
          quota,
          webhookFetch,
          options.webhookAllowedOrigins,
        );
      }
      return json(res, 201, trace);
    }

    if (method === "POST" && path === "/marketplace/skills") {
      if (!requirePlatformAdmin(req, res, platformAdminKey)) return;
      const body = await readBody(req);
      if (!body.slug || !body.name || !body.contentHash) {
        return json(res, 400, { error: "missing_fields" });
      }
      try {
        const skill = await store.publishMarketplaceSkill({
          slug: body.slug as string,
          name: body.name as string,
          description: body.description as string | undefined,
          contentHash: body.contentHash as string,
          version: body.version as string | undefined,
        });
        return json(res, 201, skill);
      } catch (err) {
        if (err instanceof Error && err.message === "marketplace_skill_not_found") {
          return json(res, 404, { error: "marketplace_skill_not_found" });
        }
        throw err;
      }
    }

    if (method === "GET" && path === "/marketplace/skills") {
      const skills = await store.listMarketplaceSkills();
      return json(res, 200, { skills });
    }

    const marketplaceSkillMatch = path.match(/^\/marketplace\/skills\/([^/]+)$/);
    if (method === "GET" && marketplaceSkillMatch) {
      const skill = await store.getMarketplaceSkill(decodeURIComponent(marketplaceSkillMatch[1]!));
      if (!skill) return json(res, 404, { error: "marketplace_skill_not_found" });
      return json(res, 200, skill);
    }

    if (method === "POST" && path === "/marketplace/subscriptions") {
      const body = await readBody(req);
      if (!body.tenantId || !body.marketplaceSkillId) {
        return json(res, 400, { error: "missing_fields" });
      }
      const auth = await requireAuth(
        req,
        res,
        store,
        authOptions,
        body.tenantId as TenantId,
      );
      if (!auth) return;
      try {
        const subscription = await store.subscribeMarketplaceSkill(
          body.tenantId as TenantId,
          body.marketplaceSkillId as string,
        );
        return json(res, 201, subscription);
      } catch (err) {
        if (err instanceof Error && err.message === "marketplace_skill_not_found") {
          return json(res, 404, { error: "marketplace_skill_not_found" });
        }
        throw err;
      }
    }

    if (method === "GET" && path === "/marketplace/subscriptions") {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const tenantId = url.searchParams.get("tenantId");
      if (!tenantId) return json(res, 400, { error: "missing_tenant_id" });
      const auth = await requireAuth(
        req,
        res,
        store,
        authOptions,
        tenantId as TenantId,
      );
      if (!auth) return;
      const subscriptions = await store.listMarketplaceSubscriptions(tenantId as TenantId);
      return json(res, 200, { subscriptions });
    }

    const marketplaceUnsubMatch = path.match(/^\/marketplace\/subscriptions\/([^/]+)$/);
    if (method === "DELETE" && marketplaceUnsubMatch) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const tenantId = url.searchParams.get("tenantId");
      if (!tenantId) return json(res, 400, { error: "missing_tenant_id" });
      const auth = await requireAuth(
        req,
        res,
        store,
        authOptions,
        tenantId as TenantId,
      );
      if (!auth) return;
      const removed = await store.unsubscribeMarketplaceSkill(
        tenantId as TenantId,
        decodeURIComponent(marketplaceUnsubMatch[1]!),
      );
      if (!removed) return json(res, 404, { error: "subscription_not_found" });
      return json(res, 200, { removed: true });
    }

    if (method === "POST" && path === "/skills") {
      const body = await readBody(req);
      if (!body.tenantId || !body.name || !body.contentHash) {
        return json(res, 400, { error: "missing_fields" });
      }
      const skill = await store.registerSkill({
        tenantId: body.tenantId as import("@diy-agent/domain").Tenant["id"],
        workspaceId: body.workspaceId as import("@diy-agent/domain").Workspace["id"] | undefined,
        name: body.name as string,
        contentHash: body.contentHash as string,
        source: (body.source as import("@diy-agent/domain").SkillSource) ?? "private",
      });
      return json(res, 201, skill);
    }

    if (method === "GET" && path.startsWith("/skills")) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const tenantId = url.searchParams.get("tenantId");
      if (!tenantId) return json(res, 400, { error: "missing_tenant_id" });
      const skills = await store.listSkills(
        tenantId as import("@diy-agent/domain").Tenant["id"],
        (url.searchParams.get("workspaceId") as import("@diy-agent/domain").Workspace["id"]) ??
          undefined,
      );
      return json(res, 200, { skills });
    }

    if (method === "POST" && path === "/mcp/catalog") {
      const body = await readBody(req);
      if (!body.tenantId || !body.serverName || !body.transport) {
        return json(res, 400, { error: "missing_fields" });
      }
      const entry = await store.registerMcp({
        tenantId: body.tenantId as import("@diy-agent/domain").Tenant["id"],
        serverName: body.serverName as string,
        transport: body.transport as import("@diy-agent/domain").McpBinding["transport"],
        command: body.command as string | undefined,
        args: body.args as string[] | undefined,
        envRef: body.envRef as Record<string, string> | undefined,
        url: body.url as string | undefined,
        defaultSensitivity:
          (body.defaultSensitivity as import("@diy-agent/domain").McpBinding["sensitivity"]) ??
          "normal",
        approvalStatus: "pending",
      });
      return json(res, 201, entry);
    }

    const mcpApproveMatch = path.match(/^\/mcp\/catalog\/([^/]+)\/approve$/);
    if (method === "POST" && mcpApproveMatch) {
      const body = await readBody(req);
      if (!body.tenantId) return json(res, 400, { error: "missing_tenant_id" });
      const entry = await store.approveMcp(
        body.tenantId as import("@diy-agent/domain").Tenant["id"],
        decodeURIComponent(mcpApproveMatch[1]!),
      );
      if (!entry) return json(res, 404, { error: "mcp_not_found" });
      await store.appendAudit({
        tenantId: body.tenantId as import("@diy-agent/domain").Tenant["id"],
        action: "mcp.registered",
        metadata: { serverName: entry.serverName },
      });
      return json(res, 200, entry);
    }

    if (method === "GET" && path.startsWith("/mcp/catalog")) {
      if (!requireServiceAccount(req, res, serviceAccountOptions)) return;
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const tenantId = url.searchParams.get("tenantId");
      if (!tenantId) return json(res, 400, { error: "missing_tenant_id" });
      const catalog = await store.listMcp(tenantId as import("@diy-agent/domain").Tenant["id"]);
      return json(res, 200, { catalog });
    }

    if (method === "POST" && path === "/credentials/refs") {
      const body = await readBody(req);
      if (!body.tenantId || !body.scope || !body.createdBy) {
        return json(res, 400, { error: "missing_fields" });
      }
      const ref = await store.registerCredentialRef({
        tenantId: body.tenantId as import("@diy-agent/domain").Tenant["id"],
        scope: body.scope as string,
        createdBy: body.createdBy as string,
        rotationAt: body.rotationAt ? new Date(body.rotationAt as string) : undefined,
      });
      return json(res, 201, ref);
    }

    if (method === "POST" && path === "/webhooks") {
      const body = await readBody(req);
      if (!body.tenantId || !body.url || !body.events) {
        return json(res, 400, { error: "missing_fields" });
      }
      const hook = await store.registerWebhook({
        tenantId: body.tenantId as import("@diy-agent/domain").Tenant["id"],
        url: body.url as string,
        events: body.events as string[],
      });
      return json(res, 201, hook);
    }

    const toolApproval=path.match(/^\/tool-approvals\/([^/]+)$/);
    if(method==="POST"&&(toolApproval||path==="/sessions/recover")){
      const body=await readBody(req);
      const profile=await store.getProfile(body.profileId as ProfileId);
      const tenant=profile?await store.getTenantForProfile(profile.id):null;
      if(!profile||!tenant)return json(res,404,{error:"profile_not_found"});
      const auth=await requireAuth(req,res,store,authOptions,tenant.id);
      if(!auth)return;
      const route=options.tenantServices?.[tenant.id];
      const url=route?.dataPlaneUrl??(!options.tenantServices?options.dataPlaneUrl:undefined);
      const token=route?.dataPlaneToken??(!options.tenantServices?options.dataPlaneInternalToken:undefined);
      if(!url||!token)return json(res,503,{error:"data_plane_route_not_configured"});
      if(typeof body.sessionId!=="string"||typeof (toolApproval?body.requestId:body.expectedRequestId)!=="string")return json(res,400,{error:"missing_fields"});
      if(toolApproval&&body.decision!=="allow"&&body.decision!=="deny")return json(res,400,{error:"invalid_approval_decision"});
      const response=await fetch(url.replace(/\/$/,"")+(toolApproval?"/tool-approvals":"/sessions/recover"),{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({tenantId:tenant.id,workspaceId:profile.workspaceId,sessionId:body.sessionId,requestId:body.requestId,expectedRequestId:body.expectedRequestId,approvalId:toolApproval?.[1],decision:body.decision,reviewer:auth.subject})});
      const result=await response.json();
      if(response.ok)await store.appendAudit({tenantId:tenant.id,workspaceId:profile.workspaceId,actor:auth.subject,action:toolApproval?"tool.approval_decided":"session.execution_recovered",metadata:{approvalId:toolApproval?.[1],sessionId:body.sessionId,requestId:body.requestId??body.expectedRequestId,decision:body.decision}});
      return json(res,response.status,result);
    }
    const revokeKey=path.match(/^\/api-keys\/([^/]+)$/);
    if(method==="DELETE"&&revokeKey){
      const body=await readBody(req);
      const removed=await store.revokeApiKey(body.tenantId as TenantId,revokeKey[1]!);
      return json(res,removed?200:404,{revoked:removed});
    }
    if (method === "POST" && path === "/api-keys") {
      const body = await readBody(req);
      if (!body.tenantId || !body.name) {
        return json(res, 400, { error: "missing_fields" });
      }
      const created = await store.createApiKey(
        body.tenantId as TenantId,
        body.name as string,
      );
      return json(res, 201, created);
    }

    if (method === "POST" && path === "/workspace-members") {
      const body = await readBody(req);
      if (!body.tenantId || !body.workspaceId || !body.userId || !body.role) {
        return json(res, 400, { error: "missing_fields" });
      }
      const auth = await requireAuth(
        req,
        res,
        store,
        authOptions,
        body.tenantId as TenantId,
      );
      if (!auth) return;
      const member = await store.addWorkspaceMember(
        body.workspaceId as import("@diy-agent/domain").WorkspaceId,
        body.userId as string,
        body.role as import("@diy-agent/domain").WorkspaceRole,
      );
      return json(res, 201, member);
    }

    const policyMatch = path.match(/^\/workspaces\/([^/]+)\/policy$/);
    if (policyMatch) {
      const workspaceId = policyMatch[1] as import("@diy-agent/domain").WorkspaceId;
      if (method === "GET") {
        const policy = await store.getWorkspacePolicy(workspaceId);
        if (!policy) return json(res, 404, { error: "policy_not_found" });
        return json(res, 200, policy);
      }
      if (method === "PUT") {
        const body = await readBody(req);
        if (!body.tenantId || !body.rules) {
          return json(res, 400, { error: "missing_fields" });
        }
        const auth = await requireAuth(
          req,
          res,
          store,
          authOptions,
          body.tenantId as TenantId,
        );
        if (!auth) return;
        const allowed = await requireWorkspacePermission(
          store,
          res,
          auth,
          authOptions,
          workspaceId,
          "policy.write",
        );
        if (!allowed) return;
        const policy = await store.setWorkspacePolicy({
          workspaceId,
          rules: body.rules as import("@diy-agent/domain").AccessPolicy["rules"],
        });
        return json(res, 200, policy);
      }
    }

    if (method === "GET" && path.startsWith("/audit")) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const tenantId = url.searchParams.get("tenantId");
      if (!tenantId) return json(res, 400, { error: "missing_tenant_id" });
      const events = await store.listAuditLog(tenantId as TenantId);
      return json(res, 200, { events });
    }

    if (method === "POST" && path === "/audit") {
      const body = await readBody(req);
      if (!body.tenantId || !body.action) {
        return json(res, 400, { error: "missing_fields" });
      }
      const event = await store.appendAudit({
        tenantId: body.tenantId as TenantId,
        workspaceId: body.workspaceId as import("@diy-agent/domain").WorkspaceId | undefined,
        action: body.action as string,
        actor: body.actor as string | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
      });
      return json(res, 201, event);
    }

    if (method === "POST" && path === "/evolution/runs") {
      const body = await readBody(req);
      if (!body.profileId || !body.tenantId) {
        return json(res, 400, { error: "missing_profile_or_tenant" });
      }
      try {
        const run = await store.createEvolutionRun({
          profileId: body.profileId as ProfileId,
          tenantId: body.tenantId as import("@diy-agent/domain").Tenant["id"],
          trigger: "manual",
          target: body.target as import("@diy-agent/domain").EvolutionRun["target"] | undefined,
          tier: body.tier as GovernanceTier | undefined,
          skillId: body.skillId as string | undefined,
        });
        if (!run) return json(res, 400, { error: "invalid_profile" });
        const profile = await store.getProfile(body.profileId as ProfileId);
        const pipeline = await executeEvolutionPipeline(
          store,
          run,
          body.tenantId as TenantId,
          evolve,
          agentRunner,
        );
        if (!pipeline) return json(res, 400, { error: "invalid_profile" });
        if (pipeline.awaitingReview) {
          await fireWebhooks(body.tenantId as string, "evolution.awaiting_review", {
            runId: pipeline.run.id,
          });
        }
        return json(res, 201, { run: pipeline.run, profile: profile?.governanceTier });
      } catch (err) {
        if (err instanceof Error && err.message === "evolution_tier_forbidden") {
          return json(res, 403, { error: "evolution_tier_forbidden" });
        }
        if (err instanceof Error && err.message === "evolution_skill_not_mutable") {
          return json(res, 403, { error: "evolution_skill_not_mutable" });
        }
        if (err instanceof Error && err.message === "evolution_skill_id_required") {
          return json(res, 400, { error: "evolution_skill_id_required" });
        }
        if (err instanceof Error && err.message.startsWith("evolution_http_")) {
          return json(res, 502, { error: "evolution_service_unavailable" });
        }
        if (err instanceof Error && err.message === "evolution_service_unavailable") {
          return json(res, 502, { error: "evolution_service_unavailable" });
        }
        throw err;
      }
    }

    if (method === "POST" && path === "/evolution/runs/trigger") {
      const body = await readBody(req);
      if (!body.profileId || !body.tenantId || body.passRate === undefined) {
        return json(res, 400, { error: "missing_fields" });
      }
      const result = await store.triggerEvolutionSignal({
        profileId: body.profileId as ProfileId,
        tenantId: body.tenantId as import("@diy-agent/domain").Tenant["id"],
        passRate: body.passRate as number,
        threshold: body.threshold as number | undefined,
      });
      if ("skipped" in result && result.skipped) {
        return json(res, 200, result);
      }
      const run = result as import("@diy-agent/domain").EvolutionRun;
      try {
        const pipeline = await executeEvolutionPipeline(
          store,
          run,
          body.tenantId as TenantId,
          evolve,
          agentRunner,
        );
        if (!pipeline) return json(res, 400, { error: "invalid_profile" });
        if (pipeline.awaitingReview) {
          await fireWebhooks(body.tenantId as string, "evolution.awaiting_review", {
            runId: pipeline.run.id,
          });
        }
        return json(res, 201, { run: pipeline.run, signal: true });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("evolution_http_")) {
          return json(res, 502, { error: "evolution_service_unavailable" });
        }
        if (err instanceof Error && err.message === "evolution_service_unavailable") {
          return json(res, 502, { error: "evolution_service_unavailable" });
        }
        throw err;
      }
    }

    const evoMatch = path.match(/^\/evolution\/runs\/([^/]+)$/);
    if (method === "GET" && evoMatch) {
      const run = await store.getEvolutionRun(evoMatch[1]!);
      if (!run) return json(res, 404, { error: "not_found" });
      return json(res, 200, run);
    }

    const evoApproveMatch = path.match(/^\/evolution\/runs\/([^/]+)\/approve$/);
    if (method === "POST" && evoApproveMatch) {
      const body = await readBody(req);
      if (!body.tenantId) return json(res, 400, { error: "missing_tenant_id" });
      const auth = await requireAuth(
        req,
        res,
        store,
        authOptions,
        body.tenantId as TenantId,
      );
      if (!auth) return;
      const pendingRun = await store.getEvolutionRun(evoApproveMatch[1]!);
      const profile = pendingRun
        ? await store.getProfile(pendingRun.profileId)
        : null;
      if (profile) {
        const allowed = await requireWorkspacePermission(
          store,
          res,
          auth,
          authOptions,
          profile.workspaceId,
          "evolution.approve",
        );
        if (!allowed) return;
      }
      const run = await store.approveEvolutionRun({
        runId: evoApproveMatch[1]!,
        tenantId: body.tenantId as TenantId,
        reviewer: auth.subject,
        candidateVersionId: body.candidateVersionId as
          | import("@diy-agent/domain").ProfileVersionId
          | undefined,
      });
      if (!run) return json(res, 404, { error: "run_not_awaiting_review" });
      const evolutionClosure = await tryAutoPinAfterEvolution(store, {
        profileId: run.profileId,
        tenantId: body.tenantId as TenantId,
        evolutionRun: run,
        fireWebhooks,
        agentRunner,
      });
      const reviewer = auth.subject;
      await emitEvolutionApproved(store, {
        tenantId: body.tenantId as TenantId,
        run,
        reviewer,
        closure: evolutionClosure,
        fireWebhooks,
      });
      return json(res, 200, {
        ...run,
        postEvolutionEval: evolutionClosure?.postEvolutionEval,
        autoPin: evolutionClosure?.pin,
      });
    }

    const evoRejectMatch = path.match(/^\/evolution\/runs\/([^/]+)\/reject$/);
    if (method === "POST" && evoRejectMatch) {
      const body = await readBody(req);
      if (!body.tenantId) return json(res, 400, { error: "missing_tenant_id" });
      const auth = await requireAuth(
        req,
        res,
        store,
        authOptions,
        body.tenantId as TenantId,
      );
      if (!auth) return;
      const run = await store.rejectEvolutionRun({
        runId: evoRejectMatch[1]!,
        tenantId: body.tenantId as TenantId,
        reviewer: auth!.subject,
        reason: body.reason as string | undefined,
      });
      if (!run) return json(res, 404, { error: "run_not_awaiting_review" });
      return json(res, 200, run);
    }

    if (method === "POST" && path === "/kb/documents") {
      const body = await readBody(req);
      if (!body.profileId || !body.title || !body.content) {
        return json(res, 400, { error: "missing_fields" });
      }
      const profile = await store.getProfile(body.profileId as ProfileId);
      if (!profile) return json(res, 404, { error: "profile_not_found" });
      const tenant = await store.getTenantForProfile(profile.id);
      const content = body.content as string;
      const contentHash = computeKbContentHash(content);
      try {
        const proxied = await proxyKbDocumentIngest(
          kbProxyOptions,
          profile,
          tenant?.id,
          body.title as string,
          content,
        );
        if (proxied.status !== 201) {
          return json(res, proxied.status, proxied.json);
        }
        const documentId = String(proxied.json.id ?? "");
        if (!documentId) {
          return json(res, 502, { error: "data_plane_invalid_ingest_response" });
        }
        const registry = await store.registerKbDocument({
          id: documentId,
          workspaceId: profile.workspaceId,
          profileId: profile.id,
          title: body.title as string,
          contentHash,
        });
        return json(res, 201, buildKbIngestResponse(registry));
      } catch {
        return json(res, 502, { error: "data_plane_unavailable" });
      }
    }

    const kbDocsMatch = path.match(/^\/profiles\/([^/]+)\/kb\/documents$/);
    if (method === "GET" && kbDocsMatch) {
      const profile = await store.getProfile(kbDocsMatch[1] as ProfileId);
      if (!profile) return json(res, 404, { error: "profile_not_found" });
      const documents = await store.listKbDocuments(profile.id);
      return json(res, 200, { documents });
    }

    if (method === "POST" && path === "/kb/search") {
      const body = await readBody(req);
      if (!body.profileId || !body.query) {
        return json(res, 400, { error: "missing_fields" });
      }
      const profile = await store.getProfile(body.profileId as ProfileId);
      if (!profile) return json(res, 404, { error: "profile_not_found" });
      const tenant = await store.getTenantForProfile(profile.id);
      try {
        const proxied = await proxyKbSearch(
          kbProxyOptions,
          profile,
          tenant?.id,
          body.query as string,
        );
        res.setHeader("Deprecation", "true");
        res.setHeader("Link", '<http://data-plane/kb/search>; rel="successor-version"');
        return json(res, proxied.status, proxied.json);
      } catch {
        return json(res, 502, { error: "data_plane_unavailable" });
      }
    }

    if (method === "POST" && path === "/orchestration/run") {
      const body = await readBody(req);
      if (!body.profileId || !body.goal) {
        return json(res, 400, { error: "missing_fields" });
      }
      const profile = await store.getProfile(body.profileId as ProfileId);
      if (!profile) return json(res, 404, { error: "profile_not_found" });
      const config =
        (body.orchestration as import("@diy-agent/domain").OrchestrationConfig) ??
        profile.orchestration ??
        { topology: "supervisor" };
      if (!["supervisor", "pipeline", "blackboard"].includes(config.topology) || (config.workerProfileIds && (!Array.isArray(config.workerProfileIds) || config.workerProfileIds.length > 32))) return json(res, 400, { error: "invalid_orchestration_config" });
      const workerIds = config.workerProfileIds?.length ? config.workerProfileIds : [profile.id];
      const snapshots = new Map<string, AgentProfile>();
      for (const id of workerIds) {
        const worker = await store.getProfile(id);
        if (!worker || worker.workspaceId !== profile.workspaceId) return json(res, 403, { error: "worker_workspace_mismatch" });
        const version = worker.pinnedVersionId ? await store.getProfileVersion(id, worker.pinnedVersionId) : await store.getLatestProfileVersion(id);
        if (!version) return json(res, 404, { error: "worker_version_not_found" });
        snapshots.set(id, version.snapshot);
      }
      const orchestrator = createOrchestrator(config.topology, async (task, context) => {
        const result = await agentRunner({ id: crypto.randomUUID(), profileId: task.workerProfileId as ProfileId, input: task.instruction + (context ? `\n\nPrevious worker output:\n${context}` : "") }, snapshots.get(task.workerProfileId)!);
        return result.output;
      });
      const plan = orchestrator.plan(body.goal as string, config, profile.id);
      const result = await orchestrator.execute(plan);
      return json(res, 200, result);
    }

    json(res, 404, { error: "not_found" });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void (async () => {
      if (await authorizeRoute(req, res, store, authOptions, serviceAccountOptions, platformAdminKey)) {
        await route(req, res, req.method ?? "GET", url.pathname);
      }
    })().catch((error: unknown) => {
      if (res.headersSent) return res.end();
      const status = error instanceof Error && error.message === "agent_runner_not_configured" ? 503 : error instanceof SyntaxError ? 400 : error instanceof Error && error.message === "request_too_large" ? 413 : error instanceof Error && error.message === "usage_event_conflict" ? 409 : 500;
      json(res, status, { error: status === 400 ? "invalid_json" : status === 413 ? "request_too_large" : "internal_error" });
    });
  });

  let closing=false;
  server.requestTimeout=150000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  server.listen(options.port ?? 0, process.env.DIY_BIND_HOST ?? "127.0.0.1");
  let cycle: Promise<unknown> | undefined;
  const interval = options.evolutionIntervalMs;
  const timer = interval && interval >= 1000 ? setInterval(() => {
    if (cycle) return;
    cycle = runEvolutionCycle(store, agentRunner, evolve, fireWebhooks)
      .catch(() => console.error("evolution_cycle_failed"))
      .finally(() => { cycle = undefined; });
  }, interval) : undefined;
  timer?.unref();

  return {
    server,
    store,
    get baseUrl() {
      const addr = server.address();
      if (!addr || typeof addr === "string") return "";
      return `http://127.0.0.1:${addr.port}`;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (timer) clearInterval(timer);
        closing=true;
        server.close((err) => {
          void Promise.resolve(cycle).then(() => store.close?.()).then(() => err ? reject(err) : resolve(), reject);
        });
      }),
  };
}

export async function startControlPlaneFromEnv(): Promise<ControlPlaneServer> {
  const dev = process.env.DIY_ALLOW_INSECURE_DEV === "true";
  const services=readTenantServices(process.env.DIY_TENANT_SERVICES);
  const oidc=[process.env.DIY_OIDC_ISSUER,process.env.DIY_OIDC_AUDIENCE,process.env.DIY_OIDC_JWKS_URL];
  if(oidc.some(Boolean)&&!oidc.every(Boolean))throw new Error("oidc_configuration_incomplete");
  if (!dev && (!process.env.DATABASE_URL || !process.env.DIY_PLATFORM_ADMIN_KEY?.startsWith("diy_pa_") || (process.env.DIY_PLATFORM_ADMIN_KEY?.length ?? 0)<32 || !process.env.DIY_TENANT_SERVICES || (process.env.DIY_EVOLUTION_INTERNAL_TOKEN?.length ?? 0)<32)) {
    throw new Error("control_plane_auth_not_configured");
  }
  const store = await createStore(process.env.DATABASE_URL);
  const port = Number(process.env.DIY_CONTROL_PLANE_PORT ?? 9878);
  const cp = createControlPlaneServer({
    store,
    port,
    storage: process.env.DATABASE_URL ? "postgres" : "memory",
    authMode: dev ? "none" : "api_key",
    webhookAllowedOrigins:dev?undefined:(process.env.DIY_WEBHOOK_ALLOWED_ORIGINS??" ").split(",").map(s=>s.trim()).filter(Boolean),
    platformAdminKey: process.env.DIY_PLATFORM_ADMIN_KEY,
    serviceAccountMode: dev ? "none" : "token",
    serviceAccountToken: dev?process.env.DIY_SERVICE_ACCOUNT_TOKEN:undefined,
    serviceAccountTenantTokens:Object.fromEntries(Object.entries(services).map(([tenant,route])=>[tenant,route.controlPlaneToken])),
    tenantServices:dev&&!process.env.DIY_TENANT_SERVICES?undefined:services,
    jwksOidc:oidc.every(Boolean)?{issuer:oidc[0]!,audience:oidc[1]!,jwksUrl:oidc[2]!}:undefined,
    dataPlaneUrl: process.env.DIY_DATA_PLANE_URL,
    dataPlaneInternalToken: process.env.DIY_DATA_PLANE_INTERNAL_TOKEN,
    evolutionIntervalMs: Number(process.env.DIY_EVOLUTION_INTERVAL_MS ?? 0),
  });
  await new Promise<void>((resolve) => {
    cp.server.once("listening", resolve);
  });
  return cp;
}
