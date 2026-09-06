/**
 * Control Plane HTTP server — testable factory + route handlers.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AgentProfile,
  OrchestrationConfig,
  TenantGateway,
  TenantId,
} from "@diy-agent/domain";
import { HybridKbService } from "@diy-agent/kb-rag";
import { createOrchestrator } from "@diy-agent/orchestrator";
import { MemoryStore, createStore, type ControlPlaneStore } from "@diy-agent/db";
import { invokeEvolutionService } from "./evolution-client.js";

export interface ControlPlaneServer {
  server: ReturnType<typeof createServer>;
  store: ControlPlaneStore & { close?: () => Promise<void> };
  baseUrl: string;
  close: () => Promise<void>;
}

export interface CreateControlPlaneOptions {
  store?: ControlPlaneStore & { close?: () => Promise<void> };
  port?: number;
  storage?: "memory" | "postgres";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createControlPlaneServer(
  options: CreateControlPlaneOptions = {}
): ControlPlaneServer {
  const store = options.store ?? new MemoryStore();
  const storage = options.storage ?? "memory";
  const kbServices = new Map<string, HybridKbService>();

  function getKbService(profile: AgentProfile): HybridKbService {
    const key = profile.id;
    let svc = kbServices.get(key);
    if (!svc) {
      svc = new HybridKbService(
        profile.kbConfig ?? { internal: { enabled: true } }
      );
      kbServices.set(key, svc);
    }
    return svc;
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string
  ): Promise<void> {
    if (method === "GET" && path === "/health") {
      return json(res, 200, { ok: true, storage, phase: 2 });
    }

    if (method === "POST" && path === "/tenants") {
      return handleCreateTenant(req, res);
    }

    const gatewayMatch = path.match(/^\/tenants\/([^/]+)\/gateway$/);
    if (method === "PUT" && gatewayMatch) {
      return handleUpdateGateway(req, res, gatewayMatch[1]!);
    }

    if (method === "POST" && path === "/workspaces") {
      return handleCreateWorkspace(req, res);
    }
    if (method === "POST" && path === "/profiles") {
      return handleCreateProfile(req, res);
    }
    if (method === "POST" && path === "/sessions") {
      return handleCreateSession(req, res);
    }

    if (method === "POST" && path === "/evolution/runs") {
      return handleCreateEvolutionRun(req, res);
    }
    if (method === "POST" && path === "/evolution/runs/trigger") {
      return handleTriggerEvolution(req, res);
    }
    const evoMatch = path.match(/^\/evolution\/runs\/([^/]+)$/);
    if (method === "GET" && evoMatch) {
      return handleGetEvolutionRun(res, evoMatch[1]!);
    }

    if (method === "POST" && path === "/kb/documents") {
      return handleKbIngest(req, res);
    }
    if (method === "POST" && path === "/kb/search") {
      return handleKbSearch(req, res);
    }

    if (method === "POST" && path === "/orchestration/run") {
      return handleOrchestrationRun(req, res);
    }

    json(res, 404, { error: "not_found" });
  }

  async function handleCreateTenant(req: IncomingMessage, res: ServerResponse) {
    const body = (await readBody(req)) as {
      name?: string;
      dbSchema?: string;
      isolationMode?: "schema" | "dedicated";
      gateway?: Partial<TenantGateway>;
    };
    const tenant = await store.createTenant({
      name: body.name ?? "unnamed",
      dbSchema: body.dbSchema,
      isolationMode: body.isolationMode,
      gateway: body.gateway,
    });
    json(res, 201, tenant);
  }

  async function handleUpdateGateway(
    req: IncomingMessage,
    res: ServerResponse,
    tenantId: string
  ) {
    const body = (await readBody(req)) as TenantGateway;
    const updated = await store.updateTenantGateway(tenantId as TenantId, body);
    if (!updated) return json(res, 404, { error: "tenant_not_found" });
    json(res, 200, updated);
  }

  async function handleCreateWorkspace(
    req: IncomingMessage,
    res: ServerResponse
  ) {
    const body = (await readBody(req)) as { tenantId?: string; name?: string };
    if (!body.tenantId) return json(res, 400, { error: "missing_tenant_id" });
    const ws = await store.createWorkspace({
      tenantId: body.tenantId as Parameters<
        ControlPlaneStore["createWorkspace"]
      >[0]["tenantId"],
      name: body.name,
    });
    if (!ws) return json(res, 400, { error: "invalid_tenant" });
    json(res, 201, ws);
  }

  async function handleCreateProfile(req: IncomingMessage, res: ServerResponse) {
    const body = (await readBody(req)) as Partial<AgentProfile> & {
      tenantId?: string;
    };
    if (!body.workspaceId || !body.tenantId) {
      return json(res, 400, { error: "missing_workspace_or_tenant" });
    }
    try {
      const result = await store.createProfile({
        workspaceId: body.workspaceId as AgentProfile["workspaceId"],
        tenantId: body.tenantId as Parameters<
          ControlPlaneStore["createProfile"]
        >[0]["tenantId"],
        profile: body,
      });
      if (!result) return json(res, 400, { error: "invalid_workspace" });
      json(res, 201, result);
    } catch (err) {
      if (err instanceof Error && err.message === "model_provider_not_allowed") {
        return json(res, 403, { error: "model_provider_not_allowed" });
      }
      throw err;
    }
  }

  async function handleCreateSession(req: IncomingMessage, res: ServerResponse) {
    const body = (await readBody(req)) as {
      profileId?: string;
      tenantId?: string;
    };
    if (!body.profileId || !body.tenantId) {
      return json(res, 400, { error: "missing_profile_or_tenant" });
    }
    const result = await store.createSession({
      profileId: body.profileId as Parameters<
        ControlPlaneStore["createSession"]
      >[0]["profileId"],
      tenantId: body.tenantId as Parameters<
        ControlPlaneStore["createSession"]
      >[0]["tenantId"],
    });
    if (!result) return json(res, 400, { error: "invalid_profile" });
    json(res, 201, result);
  }

  async function handleCreateEvolutionRun(
    req: IncomingMessage,
    res: ServerResponse
  ) {
    const body = (await readBody(req)) as {
      profileId?: string;
      tenantId?: string;
      target?: "skill" | "prompt" | "mcp_description";
      tier?: AgentProfile["governanceTier"];
    };
    if (!body.profileId || !body.tenantId) {
      return json(res, 400, { error: "missing_profile_or_tenant" });
    }
    try {
      const run = await store.createEvolutionRun({
        profileId: body.profileId as AgentProfile["id"],
        tenantId: body.tenantId as TenantId,
        trigger: "manual",
        target: body.target,
        tier: body.tier,
      });
      if (!run) return json(res, 400, { error: "invalid_profile" });

      const profile = await store.getProfile(body.profileId as AgentProfile["id"]);
      const svc = await invokeEvolutionService({
        profileId: run.profileId,
        baseVersionId: run.baseVersionId,
        tier: run.tier,
        target: run.target,
      });
      run.status = svc.status;
      run.candidateVersionId =
        svc.candidateVersionId as typeof run.candidateVersionId;
      run.evalScoreDelta = svc.evalScoreDelta;
      if (svc.requiresReview) run.status = "awaiting_review";

      json(res, 201, { run, profile: profile?.governanceTier });
    } catch (err) {
      if (err instanceof Error && err.message === "evolution_tier_forbidden") {
        return json(res, 403, { error: "evolution_tier_forbidden" });
      }
      throw err;
    }
  }

  async function handleTriggerEvolution(
    req: IncomingMessage,
    res: ServerResponse
  ) {
    const body = (await readBody(req)) as {
      profileId?: string;
      tenantId?: string;
      passRate?: number;
      threshold?: number;
    };
    if (!body.profileId || !body.tenantId || body.passRate === undefined) {
      return json(res, 400, { error: "missing_fields" });
    }
    const result = await store.triggerEvolutionSignal({
      profileId: body.profileId as AgentProfile["id"],
      tenantId: body.tenantId as TenantId,
      passRate: body.passRate,
      threshold: body.threshold,
    });
    if ("skipped" in result && result.skipped) {
      return json(res, 200, result);
    }
    const run = result as NonNullable<
      Awaited<ReturnType<ControlPlaneStore["createEvolutionRun"]>>
    >;
    const svc = await invokeEvolutionService({
      profileId: run.profileId,
      baseVersionId: run.baseVersionId,
      tier: run.tier,
      target: run.target,
    });
    run.status = svc.status;
    json(res, 201, { run, signal: true });
  }

  async function handleGetEvolutionRun(res: ServerResponse, id: string) {
    const run = await store.getEvolutionRun(id);
    if (!run) return json(res, 404, { error: "not_found" });
    json(res, 200, run);
  }

  async function handleKbIngest(req: IncomingMessage, res: ServerResponse) {
    const body = (await readBody(req)) as {
      profileId?: string;
      title?: string;
      content?: string;
    };
    if (!body.profileId || !body.title || !body.content) {
      return json(res, 400, { error: "missing_fields" });
    }
    const profile = await store.getProfile(body.profileId as AgentProfile["id"]);
    if (!profile) return json(res, 404, { error: "profile_not_found" });
    const doc = await getKbService(profile).ingest(
      profile.workspaceId,
      body.title,
      body.content
    );
    if (!doc) return json(res, 400, { error: "internal_kb_disabled" });
    json(res, 201, doc);
  }

  async function handleKbSearch(req: IncomingMessage, res: ServerResponse) {
    const body = (await readBody(req)) as { profileId?: string; query?: string };
    if (!body.profileId || !body.query) {
      return json(res, 400, { error: "missing_fields" });
    }
    const profile = await store.getProfile(body.profileId as AgentProfile["id"]);
    if (!profile) return json(res, 404, { error: "profile_not_found" });
    const result = await getKbService(profile).search(
      profile.workspaceId,
      body.query
    );
    json(res, 200, result);
  }

  async function handleOrchestrationRun(
    req: IncomingMessage,
    res: ServerResponse
  ) {
    const body = (await readBody(req)) as {
      profileId?: string;
      goal?: string;
      orchestration?: OrchestrationConfig;
    };
    if (!body.profileId || !body.goal) {
      return json(res, 400, { error: "missing_fields" });
    }
    const profile = await store.getProfile(body.profileId as AgentProfile["id"]);
    if (!profile) return json(res, 404, { error: "profile_not_found" });

    const config =
      body.orchestration ??
      profile.orchestration ?? { topology: "supervisor" as const };
    const orchestrator = createOrchestrator(config.topology);
    const plan = orchestrator.plan(body.goal, config, profile.id);
    const result = await orchestrator.execute(plan);
    json(res, 200, result);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void route(req, res, req.method ?? "GET", url.pathname);
  });

  let baseUrl = "";
  server.listen(options.port ?? 0, "127.0.0.1");

  return {
    server,
    store,
    get baseUrl() {
      if (!baseUrl) {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      return baseUrl;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          const closable = store as { close?: () => Promise<void> };
          void closable.close?.();
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
