/**
 * Control Plane HTTP server — testable factory + route handlers.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HybridKbService, PostgresKbStore } from "@diy-agent/kb-rag";
import { createOrchestrator } from "@diy-agent/orchestrator";
import {
  MemoryStore,
  PostgresStore,
  createStore,
  type ControlPlaneStore,
} from "@diy-agent/db";
import type { AgentProfile, GovernanceTier, ProfileId } from "@diy-agent/domain";
import {
  invokeEvolutionService,
  scoreProfileTask,
  evaluatePinGate,
  validateGoldenTaskCount,
} from "./evolution-client.js";

export interface ControlPlaneServer {
  server: ReturnType<typeof createServer>;
  store: ControlPlaneStore;
  baseUrl: string;
  close: () => Promise<void>;
}

export interface CreateControlPlaneOptions {
  store?: ControlPlaneStore;
  port?: number;
  storage?: "memory" | "postgres";
  evolutionInvoker?: typeof invokeEvolutionService;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function dispatchWebhooks(
  store: ControlPlaneStore,
  tenantId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  void store;
  void tenantId;
  void event;
  void payload;
}

export function createControlPlaneServer(
  options: CreateControlPlaneOptions = {},
): ControlPlaneServer {
  const store = options.store ?? new MemoryStore();
  const storage = options.storage ?? "memory";
  const evolve = options.evolutionInvoker ?? invokeEvolutionService;
  const kbServices = new Map<string, HybridKbService>();

  async function resolveKbService(profile: AgentProfile): Promise<HybridKbService> {
    let svc = kbServices.get(profile.id);
    if (!svc) {
      const tenant = await store.getTenantForProfile(profile.id);
      let internalStore;
      if (tenant && store instanceof PostgresStore) {
        internalStore = new PostgresKbStore(store.getPool(), tenant.dbSchema);
      }
      svc = new HybridKbService(profile.kbConfig ?? { internal: { enabled: true } }, internalStore);
      kbServices.set(profile.id, svc);
    }
    return svc;
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
  ): Promise<void> {
    if (method === "GET" && path === "/health") {
      return json(res, 200, { ok: true, storage, phase: 1 });
    }

    if (method === "POST" && path === "/tenants") {
      const body = await readBody(req);
      const tenant = await store.createTenant({
        name: (body.name as string) ?? "unnamed",
        dbSchema: body.dbSchema as string | undefined,
        isolationMode: body.isolationMode as import("@diy-agent/domain").IsolationMode | undefined,
        gateway: body.gateway as import("@diy-agent/domain").TenantGateway | undefined,
      });
      return json(res, 201, tenant);
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
      const ws = await store.createWorkspace({
        tenantId: body.tenantId as import("@diy-agent/domain").Tenant["id"],
        name: body.name as string | undefined,
      });
      if (!ws) return json(res, 400, { error: "invalid_tenant" });
      return json(res, 201, ws);
    }

    if (method === "POST" && path === "/profiles") {
      const body = await readBody(req);
      if (!body.workspaceId || !body.tenantId) {
        return json(res, 400, { error: "missing_workspace_or_tenant" });
      }
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
      const version = await store.getProfileVersion(
        profileVersionMatch[1] as ProfileId,
        profileVersionMatch[2]! as import("@diy-agent/domain").ProfileVersionId,
      );
      if (!version) return json(res, 404, { error: "version_not_found" });
      return json(res, 200, {
        ...version,
        credentialRefIds: [],
      });
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
      const tasks = await store.listGoldenTasks(profileId);
      const goldenCheck = validateGoldenTaskCount(tasks.length);
      if (!goldenCheck.ok) return json(res, 400, { error: goldenCheck.reason });

      const traces = await store.listTraces(profileId);
      const evalTraces = traces.map((t) => ({
        profileVersionId: t.profileVersionId,
        output: t.output,
        latencyMs: t.latencyMs,
        toolCalls: t.toolCalls,
        tokensUsed: t.tokensUsed,
      }));
      const results = tasks.map((task) =>
        scoreProfileTask(task, {
          profileVersionId: versionId,
          output: task.expectedContains?.[0] ?? "ok",
          latencyMs: 100,
        }),
      );
      const gate = evaluatePinGate(results, evalTraces);
      if (!gate.passed) {
        await dispatchWebhooks(store, body.tenantId as string, "eval.pin_gate_failed", {
          profileId,
          reasons: gate.reasons,
        });
        return json(res, 403, { error: "pin_gate_failed", gate });
      }

      const pinned = await store.pinProfile(profileId, versionId);
      if (!pinned) return json(res, 404, { error: "version_not_found" });
      await store.appendAudit({
        tenantId: body.tenantId as import("@diy-agent/domain").Tenant["id"],
        workspaceId: profile.workspaceId,
        action: "profile.pinned",
        metadata: { profileId, versionId },
      });
      await dispatchWebhooks(store, body.tenantId as string, "profile.pinned", {
        profileId,
        versionId,
      });
      return json(res, 200, { profile: pinned, gate });
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
      return json(res, 201, { ...result, quotaWarning: quota.warning ?? false });
    }

    if (method === "POST" && path === "/golden-tasks") {
      const body = await readBody(req);
      if (!body.profileId || !body.input) return json(res, 400, { error: "missing_fields" });
      const task = await store.createGoldenTask({
        profileId: body.profileId as ProfileId,
        input: body.input as string,
        expectedContains: body.expectedContains as string[] | undefined,
        maxLatencyMs: body.maxLatencyMs as number | undefined,
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

    if (method === "POST" && path === "/traces") {
      const body = await readBody(req);
      if (!body.profileId || !body.profileVersionId || body.latencyMs === undefined) {
        return json(res, 400, { error: "missing_fields" });
      }
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
        await store.recordTokenUsage(
          body.tenantId as import("@diy-agent/domain").Tenant["id"],
          body.tokensUsed as number,
        );
      }
      return json(res, 201, trace);
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
      const url = new URL(path, "http://local");
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
      const url = new URL(path, "http://local");
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
        });
        if (!run) return json(res, 400, { error: "invalid_profile" });
        const profile = await store.getProfile(body.profileId as ProfileId);
        const version = await store.getLatestProfileVersion(run.profileId);
        const traces = await store.listTraces(run.profileId, 50);
        const goldenTasks = await store.listGoldenTasks(run.profileId);
        const svc = await evolve({
          profileId: run.profileId,
          baseVersionId: run.baseVersionId,
          tier: run.tier,
          target: run.target,
          snapshot: version?.snapshot,
          evalTasks: goldenTasks,
          traces,
        });
        run.status = svc.status;
        if (svc.candidateVersionId) {
          run.candidateVersionId =
            svc.candidateVersionId as import("@diy-agent/domain").ProfileVersionId;
        }
        run.evalScoreDelta = svc.evalScoreDelta;
        if (svc.requiresReview) run.status = "awaiting_review";
        if (run.status === "awaiting_review") {
          await dispatchWebhooks(store, body.tenantId as string, "evolution.awaiting_review", {
            runId: run.id,
          });
        }
        return json(res, 201, { run, profile: profile?.governanceTier });
      } catch (err) {
        if (err instanceof Error && err.message === "evolution_tier_forbidden") {
          return json(res, 403, { error: "evolution_tier_forbidden" });
        }
        if (err instanceof Error && err.message.startsWith("evolution_http_")) {
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
        const version = await store.getLatestProfileVersion(run.profileId);
        const traces = await store.listTraces(run.profileId, 50);
        const goldenTasks = await store.listGoldenTasks(run.profileId);
        const svc = await evolve({
          profileId: run.profileId,
          baseVersionId: run.baseVersionId,
          tier: run.tier,
          target: run.target,
          snapshot: version?.snapshot,
          evalTasks: goldenTasks,
          traces,
        });
        run.status = svc.status;
        return json(res, 201, { run, signal: true });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("evolution_http_")) {
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

    if (method === "POST" && path === "/kb/documents") {
      const body = await readBody(req);
      if (!body.profileId || !body.title || !body.content) {
        return json(res, 400, { error: "missing_fields" });
      }
      const profile = await store.getProfile(body.profileId as ProfileId);
      if (!profile) return json(res, 404, { error: "profile_not_found" });
      const doc = await (await resolveKbService(profile)).ingest(
        profile.workspaceId,
        body.title as string,
        body.content as string,
      );
      if (!doc) return json(res, 400, { error: "internal_kb_disabled" });
      return json(res, 201, doc);
    }

    if (method === "POST" && path === "/kb/search") {
      const body = await readBody(req);
      if (!body.profileId || !body.query) {
        return json(res, 400, { error: "missing_fields" });
      }
      const profile = await store.getProfile(body.profileId as ProfileId);
      if (!profile) return json(res, 404, { error: "profile_not_found" });
      const result = await (await resolveKbService(profile)).search(
        profile.workspaceId,
        body.query as string,
      );
      return json(res, 200, result);
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
      const orchestrator = createOrchestrator(config.topology);
      const plan = orchestrator.plan(body.goal as string, config, profile.id);
      const result = await orchestrator.execute(plan);
      return json(res, 200, result);
    }

    json(res, 404, { error: "not_found" });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void route(req, res, req.method ?? "GET", url.pathname);
  });

  server.listen(options.port ?? 0, "127.0.0.1");

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
        server.close((err) => {
          void store.close?.();
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

export async function startControlPlaneFromEnv(): Promise<ControlPlaneServer> {
  const store = await createStore(process.env.DATABASE_URL);
  const port = Number(process.env.DIY_CONTROL_PLANE_PORT ?? 9878);
  const cp = createControlPlaneServer({
    store,
    port,
    storage: process.env.DATABASE_URL ? "postgres" : "memory",
  });
  await new Promise<void>((resolve) => {
    cp.server.once("listening", resolve);
  });
  return cp;
}
