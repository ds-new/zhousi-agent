import type { KbSearchOptions } from "./types.js";
export const EMBEDDING_DIMENSIONS = 128;

/** Deterministic local embedding — production replaces with gateway-routed model. */
export function embedText(text: string, dims = EMBEDDING_DIMENSIONS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
    }
    vec[hash % dims]! += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vec.map((value) => value / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export type EmbeddingProvider = (text: string, options?: KbSearchOptions) => Promise<number[]>;

/** PostgreSQL schema and all retrieval vectors use the same fixed dimension contract. */
export function validateEmbedding(values: number[]): number[] {
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS || values.some(value => typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 3.402823466e38) || !values.some(value => value !== 0)) throw new Error("kb_embedding_invalid");
  return [...values];
}
