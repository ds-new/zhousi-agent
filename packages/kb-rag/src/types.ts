import type { WorkspaceId } from "@diy-agent/domain";

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

export interface KbStore {
  ingest(doc: Omit<KbDocument, "id" | "createdAt">): Promise<KbDocument>;
  search(workspaceId: WorkspaceId, query: string, limit?: number): Promise<KbSearchHit[]>;
}
