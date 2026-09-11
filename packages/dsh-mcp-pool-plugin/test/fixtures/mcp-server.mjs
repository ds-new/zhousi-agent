import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.registerTool("echo", { inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: "text", text: message }] }));
server.registerTool("search", { inputSchema: { query: z.string() } }, async ({ query }) => ({ content: [{ type: "text", text: JSON.stringify({ hits: [{ documentId: "faq-1", title: "FAQ", snippet: query, score: 0.9 }] }) }] }));
await server.connect(new StdioServerTransport());
