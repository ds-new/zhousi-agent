import type { KnowledgeBaseConfig, McpBinding, WorkspaceId } from "@diy-agent/domain";

export interface KbDocument {
  id: string;
  workspaceId: WorkspaceId;
  title: string;
  content: string;
  embedding?: number[];
  createdAt: Date;
}

export interface KbSearchHit {
  documentId: string;
  title: string;
  snippet: string;
  score: number;
  source: "internal" | "external_mcp";
}

export interface KbSearchResult {
  query: string;
  hits: KbSearchHit[];
}

const internalIndex = new Map<string, KbDocument[]>();

export class InternalKbStore {
  async ingest(doc: Omit<KbDocument, "id" | "createdAt">): Promise<KbDocument> {
    const entry: KbDocument = {
      ...doc,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    const list = internalIndex.get(doc.workspaceId) ?? [];
    list.push(entry);
    internalIndex.set(doc.workspaceId, list);
    return entry;
  }

  async search(workspaceId: WorkspaceId, query: string, limit = 5): Promise<KbSearchHit[]> {
    const docs = internalIndex.get(workspaceId) ?? [];
    const q = query.toLowerCase();
    return docs
      .map((d) => ({
        documentId: d.id,
        title: d.title,
        snippet: d.content.slice(0, 200),
        score: scoreMatch(d, q),
        source: "internal" as const,
      }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

function scoreMatch(doc: KbDocument, query: string): number {
  const text = `${doc.title} ${doc.content}`.toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const hits = terms.filter((t) => text.includes(t)).length;
  return hits / terms.length;
}

export class ExternalMcpKbConnector {
  constructor(private binding: McpBinding) {}

  async search(_query: string): Promise<KbSearchHit[]> {
    return [
      {
        documentId: `ext-${this.binding.serverName}`,
        title: `${this.binding.serverName} KB`,
        snippet: `[external MCP: ${this.binding.serverName}]`,
        score: 0.5,
        source: "external_mcp",
      },
    ];
  }
}

function reciprocalRankFusion(
  lists: KbSearchHit[][],
  weights: number[],
  k = 60,
): KbSearchHit[] {
  const scores = new Map<string, KbSearchHit & { rrf: number }>();
  for (let i = 0; i < lists.length; i++) {
    const weight = weights[i] ?? 1;
    lists[i].forEach((hit, rank) => {
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
  private internal = new InternalKbStore();

  constructor(private config: KnowledgeBaseConfig) {}

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
      const ext = new ExternalMcpKbConnector(this.config.externalMcp);
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

export function getInternalIndex(): Map<string, KbDocument[]> {
  return internalIndex;
}
