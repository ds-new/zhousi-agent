import pg from "pg";
import type { WorkspaceId } from "@diy-agent/domain";
import { EMBEDDING_DIMENSIONS, cosineSimilarity, embedText, validateEmbedding, type EmbeddingProvider } from "./embedding.js";
import type { KbDocument, KbSearchHit } from "./types.js";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function toVectorLiteral(values: number[]): string {
  return `[${validateEmbedding(values).join(",")}]`;
}

export class PostgresKbStore {
  constructor(
    private pool: pg.Pool,
    private schema: string,
    private embeddingProvider?: EmbeddingProvider,
  ) {}

  async ingest(doc: Omit<KbDocument, "id" | "createdAt">): Promise<KbDocument> {
    const id = crypto.randomUUID();
    const text = `${doc.title} ${doc.content}`;
    const embedding = validateEmbedding(doc.embedding ?? (this.embeddingProvider ? await this.embeddingProvider(text) : embedText(text)));
    const createdAt = new Date();
    const schema = quoteIdent(this.schema);
    await this.pool.query(
      `INSERT INTO ${schema}.kb_documents (id, workspace_id, title, content, embedding, created_at)
       VALUES ($1, $2, $3, $4, $5::vector, $6)`,
      [id, doc.workspaceId, doc.title, doc.content, toVectorLiteral(embedding), createdAt],
    );
    return { ...doc, id, embedding, createdAt };
  }

  async search(workspaceId: WorkspaceId, query: string, limit = 5): Promise<KbSearchHit[]> {
    const schema = quoteIdent(this.schema);
    const queryEmbedding = toVectorLiteral(this.embeddingProvider ? await this.embeddingProvider(query) : embedText(query));
    const result = await this.pool.query<{
      id: string;
      title: string;
      content: string;
      score: number;
    }>(
      `SELECT id, title, content, 1 - (embedding <=> $2::vector) AS score
       FROM ${schema}.kb_documents
       WHERE workspace_id = $1
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [workspaceId, queryEmbedding, limit],
    );

    return result.rows.map((row) => ({
      documentId: row.id,
      title: row.title,
      snippet: row.content.slice(0, 200),
      score: row.score,
      source: "internal" as const,
    }));
  }

  /** Fallback search without pgvector operators (tests / degraded mode). */
  async searchInMemoryFallback(workspaceId: WorkspaceId, query: string, limit = 5): Promise<KbSearchHit[]> {
    const schema = quoteIdent(this.schema);
    const result = await this.pool.query<{
      id: string;
      title: string;
      content: string;
      embedding: string;
    }>(`SELECT id, title, content, embedding::text AS embedding FROM ${schema}.kb_documents WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    const queryEmbedding = validateEmbedding(this.embeddingProvider ? await this.embeddingProvider(query) : embedText(query));
    return result.rows
      .map((row) => {
        const parsed = parseVector(row.embedding);
        return {
          documentId: row.id,
          title: row.title,
          snippet: row.content.slice(0, 200),
          score: cosineSimilarity(queryEmbedding, parsed),
          source: "internal" as const,
        };
      })
      .filter((hit) => hit.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

function parseVector(raw: string): number[] {
  const trimmed = raw.replace(/[\[\]]/g, "");
  if (!trimmed) return [];
  return trimmed.split(",").map((part) => Number(part.trim()));
}
