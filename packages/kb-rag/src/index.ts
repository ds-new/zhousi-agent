import type { KnowledgeBaseConfig, WorkspaceId } from "@diy-agent/domain";
import { InternalKbStore } from "./internal-kb-store.js";
import {
  ExternalMcpKbConnector,
  HttpMcpKbSearchClient,
  type McpKbSearchClient,
  type McpKbSearchContext,
} from "./external-mcp-kb-connector.js";
import type { KbDocument, KbSearchHit, KbSearchResult, KbStore } from "./types.js";

export type { KbDocument, KbSearchHit, KbSearchResult, KbStore } from "./types.js";
export { embedText, cosineSimilarity, EMBEDDING_DIMENSIONS } from "./embedding.js";
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

  constructor(
    private config: KnowledgeBaseConfig,
    internalStore?: KbStore,
    private externalClient?: McpKbSearchClient,
    private mcpContext: McpKbSearchContext = {},
  ) {
    this.internal = internalStore ?? new InternalKbStore();
  }

  async ingest(
    workspaceId: WorkspaceId,
    title: string,
    content: string,
  ): Promise<KbDocument | null> {
    if (!this.config.internal?.enabled) return null;
    return this.internal.ingest({ workspaceId, title, content });
  }

  async search(workspaceId: WorkspaceId, query: string): Promise<KbSearchResult> {
    const weights = this.config.fusionWeights ?? { internal: 0.6, external: 0.4 };
    const lists: KbSearchHit[][] = [];

    if (this.config.internal?.enabled) {
      lists.push(await this.internal.search(workspaceId, query));
    }
    if (this.config.externalMcp) {
      const ext = new ExternalMcpKbConnector(
        this.config.externalMcp,
        this.externalClient ?? new HttpMcpKbSearchClient(),
        { ...this.mcpContext, workspaceId },
      );
      lists.push(await ext.search(query));
    }

    if (lists.length <= 1) {
      const hits = lists[0] ?? [];
      hits.sort((a, b) => b.score - a.score);
      return { query, hits };
    }

    const hits = reciprocalRankFusion(lists, [weights.internal, weights.external]);
    return { query, hits };
  }
}
