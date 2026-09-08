/**
 * Minimal Data Plane HTTP surface for Enterprise deployments (:3080).
 */
import { createServer, type IncomingMessage } from "node:http";
import {
  createKbRuntime,
  handleKbDocumentHttp,
  handleKbSearchHttp,
  validateInternalToken,
  type KbRuntime,
  type KbRuntimeDeps,
} from "@diy-agent/dsh-kb-plugin";
import {
  getCachedProfileSync,
  handleProfilePinnedWebhook,
} from "@diy-agent/dsh-profile-sync-plugin";

export interface DataPlaneServerOptions {
  port?: number;
  internalToken?: string;
  kbRuntime?: KbRuntime;
  kbRuntimeDeps?: KbRuntimeDeps;
}

export interface DataPlaneServer {
  server: ReturnType<typeof createServer>;
  baseUrl: string;
  kbRuntime: KbRuntime;
  close: () => Promise<void>;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

interface WebhookProfilePinnedPayload {
  profileId?: string;
  versionId?: string;
  workspaceId?: string;
  tenantId?: string;
  snapshot?: Record<string, unknown>;
  pinnedAt?: string;
  policy?: import("@diy-agent/domain").AccessPolicy;
  credentialRefIds?: string[];
  mcpCatalog?: import("@diy-agent/domain").McpCatalogEntry[];
}

export function createDataPlaneServer(options: DataPlaneServerOptions = {}): DataPlaneServer {
  const internalToken = options.internalToken ?? process.env.DIY_DATA_PLANE_INTERNAL_TOKEN;
  const kbRuntime = options.kbRuntime ?? createKbRuntime(options.kbRuntimeDeps);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/health") {
      return respond(200, { ok: true, plane: "data", port: 3080 });
    }

    const cacheMatch = url.pathname.match(/^\/profile-sync\/cache\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && cacheMatch) {
      const cached = getCachedProfileSync(cacheMatch[1]!, cacheMatch[2]!);
      if (!cached) return respond(404, { error: "cache_miss" });
      return respond(200, cached);
    }

    if (req.method === "POST" && url.pathname === "/webhooks/profile-sync") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          event?: string;
          payload?: WebhookProfilePinnedPayload;
          profileId?: string;
          versionId?: string;
          snapshot?: Record<string, unknown>;
          pinnedAt?: string;
          workspaceId?: string;
          tenantId?: string;
          policy?: import("@diy-agent/domain").AccessPolicy;
          credentialRefIds?: string[];
          mcpCatalog?: import("@diy-agent/domain").McpCatalogEntry[];
        };
        const payload = (body.payload ?? body) as WebhookProfilePinnedPayload;
        const entry = handleProfilePinnedWebhook({
          profileId: String(payload.profileId ?? ""),
          versionId: String(payload.versionId ?? ""),
          workspaceId: String(payload.workspaceId ?? ""),
          tenantId: String(payload.tenantId ?? ""),
          snapshot: payload.snapshot,
          pinnedAt: payload.pinnedAt,
          policy: payload.policy,
          credentialRefIds: payload.credentialRefIds,
          mcpCatalog: payload.mcpCatalog,
        });
        if (!entry) return respond(400, { error: "missing_snapshot" });
        respond(201, entry);
      });
      return;
    }

    if (req.method === "POST" && (url.pathname === "/kb/search" || url.pathname === "/kb/documents")) {
      if (!validateInternalToken(req, internalToken)) {
        return respond(401, { error: "unauthorized" });
      }
      void (async () => {
        const body = await readJsonBody(req);
        const result =
          url.pathname === "/kb/search"
            ? await handleKbSearchHttp(kbRuntime, body)
            : await handleKbDocumentHttp(kbRuntime, body);
        respond(result.status, result.body);
      })().catch(() => respond(500, { error: "kb_handler_failed" }));
      return;
    }

    respond(404, { error: "not_found" });
  });

  const listenPort = options.port ?? 0;
  server.listen(listenPort, "127.0.0.1");

  return {
    server,
    kbRuntime,
    get baseUrl() {
      const addr = server.address();
      if (!addr || typeof addr === "string") return "";
      return `http://127.0.0.1:${addr.port}`;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export async function startDataPlaneFromEnv(): Promise<DataPlaneServer> {
  const port = Number(process.env.DIY_DATA_PLANE_PORT ?? 3080);
  const dp = createDataPlaneServer({ port });
  await new Promise<void>((resolve) => dp.server.once("listening", resolve));
  return dp;
}
