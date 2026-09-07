/**
 * Minimal Data Plane HTTP surface for Enterprise deployments (:3080).
 */
import { createServer } from "node:http";
import {
  getCachedProfileSync,
  handleProfilePinnedWebhook,
} from "@diy-agent/dsh-profile-sync-plugin";

export interface DataPlaneServer {
  server: ReturnType<typeof createServer>;
  baseUrl: string;
  close: () => Promise<void>;
}

export function createDataPlaneServer(port = 0): DataPlaneServer {
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
          payload?: {
            profileId?: string;
            versionId?: string;
            snapshot?: Record<string, unknown>;
            pinnedAt?: string;
          };
          profileId?: string;
          versionId?: string;
          snapshot?: Record<string, unknown>;
          pinnedAt?: string;
        };
        const payload = body.payload ?? body;
        const entry = handleProfilePinnedWebhook({
          profileId: String(payload.profileId ?? ""),
          versionId: String(payload.versionId ?? ""),
          snapshot: payload.snapshot,
          pinnedAt: payload.pinnedAt,
        });
        if (!entry) return respond(400, { error: "missing_snapshot" });
        respond(201, entry);
      });
      return;
    }

    respond(404, { error: "not_found" });
  });

  server.listen(port, "127.0.0.1");

  return {
    server,
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
  const dp = createDataPlaneServer(port);
  await new Promise<void>((resolve) => dp.server.once("listening", resolve));
  return dp;
}
