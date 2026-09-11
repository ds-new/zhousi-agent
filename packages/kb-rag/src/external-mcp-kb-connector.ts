import { ProtocolMcpKbSearchClient } from "./protocol-mcp-kb-client.js";
import { acquire, release } from "@diy-agent/dsh-mcp-pool-plugin";
import type { McpBinding } from "@diy-agent/domain";
import type { KbSearchHit } from "./types.js";

export interface McpKbSearchContext {
  tenantId?: string;
  workspaceId?: string;
  sessionId?: string;
}

export interface McpKbSearchClient {
  close?(): Promise<void>;
  search(
    binding: McpBinding,
    query: string,
    ctx: McpKbSearchContext,
  ): Promise<KbSearchHit[]>;
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export class HttpMcpKbSearchClient implements McpKbSearchClient {
  constructor(private fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {}

  async search(
    binding: McpBinding,
    query: string,
    ctx: McpKbSearchContext,
  ): Promise<KbSearchHit[]> {
    if (!binding.url) {
      throw new Error("external_mcp_url_required");
    }

    acquire(binding, ctx);
    try {
      const res = await this.fetchImpl(`${binding.url.replace(/\/$/, "")}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) {
        throw new Error(`external_mcp_search_${res.status}`);
      }
      const body = (await res.json()) as {
        hits?: Array<Omit<KbSearchHit, "source"> & { source?: KbSearchHit["source"] }>;
      };
      return (body.hits ?? []).map((hit) => ({
        documentId: hit.documentId,
        title: hit.title,
        snippet: hit.snippet,
        score: hit.score,
        source: hit.source ?? "external_mcp",
      }));
    } finally {
      release(binding, ctx);
    }
  }
}

export class ExternalMcpKbConnector {
  private client: McpKbSearchClient;
  private ownsClient: boolean;
  constructor(
    private binding: McpBinding,
    client?: McpKbSearchClient,
    private ctx: McpKbSearchContext = {},
  ) { this.client = client ?? new ProtocolMcpKbSearchClient(); this.ownsClient = !client; }

  async close(): Promise<void> { if (this.ownsClient) await this.client.close?.(); }

  async search(query: string): Promise<KbSearchHit[]> {
    return this.client.search(this.binding, query, this.ctx);
  }
}
