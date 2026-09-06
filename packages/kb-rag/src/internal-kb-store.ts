import type { WorkspaceId } from "@diy-agent/domain";
import type { KbDocument, KbSearchHit } from "./types.js";
import { cosineSimilarity, embedText } from "./embedding.js";

const internalIndex = new Map<string, KbDocument[]>();

export class InternalKbStore {
  async ingest(doc: Omit<KbDocument, "id" | "createdAt">): Promise<KbDocument> {
    const embedding = doc.embedding ?? embedText(`${doc.title} ${doc.content}`);
    const entry: KbDocument = {
      ...doc,
      embedding,
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
    if (docs.length === 0) return [];

    const queryEmbedding = embedText(query);
    return docs
      .map((doc) => ({
        documentId: doc.id,
        title: doc.title,
        snippet: doc.content.slice(0, 200),
        score: cosineSimilarity(queryEmbedding, doc.embedding ?? embedText(doc.content)),
        source: "internal" as const,
      }))
      .filter((hit) => hit.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

export function getInternalIndex(): Map<string, KbDocument[]> {
  return internalIndex;
}

export function resetInternalIndexForTests(): void {
  internalIndex.clear();
}
