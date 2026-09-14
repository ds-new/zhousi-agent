import { McpConnectionPool, type McpConnectionOptions } from "@diy-agent/dsh-mcp-pool-plugin";
import { runSearch } from "./search-operation.js";
import type { McpBinding } from "@diy-agent/domain";
import type { McpKbSearchClient, McpKbSearchContext } from "./external-mcp-kb-connector.js";
import type { KbSearchHit, KbSearchOptions } from "./types.js";

/** An injected pool belongs to its caller; otherwise this client owns and closes its pool. */
export class ProtocolMcpKbSearchClient implements McpKbSearchClient {
  private ownedPool?: McpConnectionPool;
  private closed = false;
  constructor(private pool?: McpConnectionPool, private options: McpConnectionOptions = {}) {}

  async search(binding: McpBinding, query: string, context: McpKbSearchContext, options: KbSearchOptions = {}): Promise<KbSearchHit[]> {
    return runSearch(options, scoped => this.execute(binding, query, context, scoped));
  }

  private async execute(binding: McpBinding, query: string, context: McpKbSearchContext, options: KbSearchOptions): Promise<KbSearchHit[]> {
    if (this.closed) throw new Error("mcp_kb_client_closed");
    if (typeof query !== "string" || !query.trim() || query.length > 16_384) throw new Error("mcp_kb_query_invalid");
    const pool = this.pool ?? (this.ownedPool ??= new McpConnectionPool(this.options));
    const lease = await pool.connect(binding, context, { signal: options.signal });
    try {
      const result = await lease.callTool({ name: binding.searchTool ?? "search", arguments: { query } }, { signal: options.signal, timeout: options.timeoutMs });
      if (result.isError) throw new Error("mcp_kb_search_failed");
      let payload: unknown = result.structuredContent;
      if (!payload && Array.isArray(result.content)) {
        const block = result.content.find(b => b.type === "text");
        if (block && typeof block.text === "string") {
          if (block.text.length > 1_048_576) throw new Error("mcp_kb_result_too_large");
          payload = JSON.parse(block.text);
        }
      }
      const hits = (payload as { hits?: unknown[] } | undefined)?.hits;
      if (!Array.isArray(hits)) throw new Error("mcp_kb_invalid_result");
      return hits.slice(0, 100).map(value => {
        if (!value || typeof value !== "object") throw new Error("mcp_kb_invalid_hit");
        const hit = value as KbSearchHit;
        if (typeof hit.documentId !== "string" || !hit.documentId || hit.documentId.length > 256 || typeof hit.title !== "string" || typeof hit.snippet !== "string" || !Number.isFinite(hit.score)) throw new Error("mcp_kb_invalid_hit");
        return { documentId: hit.documentId, title: hit.title.slice(0, 512), snippet: hit.snippet.slice(0, 4096), score: hit.score, source: "external_mcp" };
      });
    } finally { await lease.release(); }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.ownedPool?.close();
  }
}
