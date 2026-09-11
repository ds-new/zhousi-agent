import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** A real stateful MCP server over localhost HTTP; no fetch mocking. */
export async function startHttpMcp(options: { repeatCursor?: boolean; toolCount?: number; token?: string } = {}) {
  const connections = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  let initializes = 0;
  let deleted = 0;
  const http = createServer(async (req, res) => {
    if (options.token && req.headers.authorization !== options.token) { res.writeHead(401).end(); return; }
    try {
      let body: unknown;
      if (req.method === "POST") { let raw = ""; for await (const chunk of req) raw += chunk; body = JSON.parse(raw); }
      const id = req.headers["mcp-session-id"] as string | undefined;
      let connection = id ? connections.get(id) : undefined;
      if (!connection && (body as { method?: string })?.method === "initialize") {
        initializes++;
        const server = new Server({ name: "http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Array.from({ length: options.toolCount ?? 2 }, (_, i) => ({ name: i ? `tool_${i}` : "echo", inputSchema: { type: "object" as const } })), ...(options.repeatCursor ? { nextCursor: "same-page" } : {}) }));
        server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
          if (params.name === "slow") await new Promise<void>(resolve => { const timer = setTimeout(resolve, 10_000); extra.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
          return { content: [{ type: "text", text: String(params.arguments?.message ?? "ok") }] };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
        connection = { transport, server };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        connections.set(transport.sessionId!, connection);
        return;
      }
      if (!connection) { res.writeHead(404).end(); return; }
      if (req.method === "DELETE") deleted++;
      await connection.transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) res.writeHead(500).end(); else res.end(); }
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
  return { url, stats: () => ({ initializes, deleted }), close: async () => { await Promise.all([...connections.values()].map(c => c.server.close())); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); } };
}
