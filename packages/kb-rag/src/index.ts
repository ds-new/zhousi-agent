import type { KnowledgeBaseConfig, WorkspaceId } from "@diy-agent/domain";
import { InternalKbStore } from "./internal-kb-store.js";
import { ProtocolMcpKbSearchClient } from "./protocol-mcp-kb-client.js";
export { ProtocolMcpKbSearchClient } from "./protocol-mcp-kb-client.js";
export type { McpConnectionOptions } from "@diy-agent/dsh-mcp-pool-plugin";
import {
  ExternalMcpKbConnector,
  HttpMcpKbSearchClient,
  type McpKbSearchClient,
  type McpKbSearchContext,
} from "./external-mcp-kb-connector.js";
import { runSearch, observeCancellation } from "./search-operation.js";
import type { KbDocument, KbSearchHit, KbSearchResult, KbStore, KbSearchOptions } from "./types.js";

export { runSearch } from "./search-operation.js";
export type { KbDocument, KbSearchHit, KbSearchResult, KbStore, KbSearchOptions } from "./types.js";
export { embedText, cosineSimilarity, EMBEDDING_DIMENSIONS, validateEmbedding, type EmbeddingProvider } from "./embedding.js";
export { InternalKbStore, getInternalIndex, resetInternalIndexForTests } from "./internal-kb-store.js";
export { PostgresKbStore } from "./postgres-kb-store.js";
export {
  ExternalMcpKbConnector,
  HttpMcpKbSearchClient,
  type McpKbSearchClient,
  type McpKbSearchContext,
} from "./external-mcp-kb-connector.js";

function reciprocalRankFusion(
  lists: KbSearchHit[][],
  weights: number[],
  k = 60,
): KbSearchHit[] {
  const scores = new Map<string, KbSearchHit & { rrf: number }>();
  for (let i = 0; i < lists.length; i++) {
    const weight = weights[i] ?? 1;
    lists[i]!.forEach((hit, rank) => {
      const existing = scores.get(hit.documentId);
      const contribution = weight * (1 / (k + rank + 1));
      if (existing) {
        existing.rrf += contribution;
      } else {
        scores.set(hit.documentId, { ...hit, rrf: contribution });
      }
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .map(({ rrf, ...hit }) => ({ ...hit, score: rrf }));
}

export class HybridKbService {
  private internal: KbStore;
  private ownedExternalClient?: ProtocolMcpKbSearchClient;

  constructor(
    private config: KnowledgeBaseConfig,
    internalStore?: KbStore,
    private externalClient?: McpKbSearchClient,
    private mcpContext: McpKbSearchContext = {},
  ) {
    this.internal = internalStore ?? new InternalKbStore();
  }

  async close(): Promise<void> { await this.ownedExternalClient?.close(); }

  async ingest(
    workspaceId: WorkspaceId,
    title: string,
    content: string,
  ): Promise<KbDocument | null> {
    if (!this.config.internal?.enabled) return null;
    return this.internal.ingest({ workspaceId, title, content });
  }

  async search(workspaceId: WorkspaceId, query: string, options: KbSearchOptions = {}): Promise<KbSearchResult> {
    return runSearch(options, async context => {
      const weights = this.config.fusionWeights ?? { internal: 0.6, external: 0.4 };
      const internal = () => observeCancellation(this.internal.search(workspaceId, query, undefined, context), context.signal);
      const external = () => {
        const connector = new ExternalMcpKbConnector(this.config.externalMcp!,
          this.externalClient ?? (this.ownedExternalClient ??= new ProtocolMcpKbSearchClient()),
          { ...this.mcpContext, workspaceId });
        return observeCancellation(connector.search(query, context), context.signal);
      };
      let lists: KbSearchHit[][];
      if (this.config.internal?.enabled && this.config.externalMcp) {
        // Only an operator-approved readonly binding can execute independently of the internal read.
        lists = this.config.externalMcp.sensitivity === "readonly"
          ? await Promise.all([Promise.resolve().then(internal), Promise.resolve().then(external)])
          : [await internal(), await external()];
      } else if (this.config.internal?.enabled) lists = [await internal()];
      else if (this.config.externalMcp) lists = [await external()];
      else lists = [];
      const hits = lists.length > 1
        ? reciprocalRankFusion(lists, [weights.internal, weights.external])
        : [...(lists[0] ?? [])].sort((a, b) => b.score - a.score);
      return { query, hits };
    });
  }
}
