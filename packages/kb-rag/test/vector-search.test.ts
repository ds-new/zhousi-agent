import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { embedText, cosineSimilarity } from "../src/embedding.js";
import { InternalKbStore } from "../src/internal-kb-store.js";

describe("kb-rag vector search", () => {
  it("embedText produces normalized vectors", () => {
    const v = embedText("hello world");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 0.001);
  });

  it("cosineSimilarity ranks related content higher", () => {
    const q = embedText("refund policy");
    const a = embedText("Our refund policy allows returns within 30 days");
    const b = embedText("Database migration guide for kubernetes");
    assert.ok(cosineSimilarity(q, a) > cosineSimilarity(q, b));
  });

  it("InternalKbStore uses vector similarity for search", async () => {
    const store = new InternalKbStore();
    const ws = "ws-1" as import("@diy-agent/domain").WorkspaceId;
    await store.ingest({
      workspaceId: ws,
      title: "Returns",
      content: "Customers can request a refund within 30 days of purchase.",
    });
    await store.ingest({
      workspaceId: ws,
      title: "DevOps",
      content: "Kubernetes cluster scaling and pod autoscaling.",
    });
    const hits = await store.search(ws, "how do refunds work");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]!.title, "Returns");
    assert.equal(hits[0]!.source, "internal");
  });
});

it("uses asynchronous configured embeddings for ingestion and retrieval and rejects malformed vectors", async () => {
  const calls: string[] = [];
  const semanticVector = (text: string) => Array.from({ length: 128 }, (_, i) => i === (text.includes("car") || text.includes("automobile") ? 0 : 1) ? 1 : 0);
  const store = new InternalKbStore(async text => { calls.push(text); return semanticVector(text); });
  const workspaceId = crypto.randomUUID() as import("@diy-agent/domain").WorkspaceId;
  await store.ingest({ workspaceId, title: "Vehicles", content: "automobile manual" });
  await store.ingest({ workspaceId, title: "Marine", content: "ocean fish" });
  const result = await store.search(workspaceId, "car");
  assert.equal(result[0]?.title, "Vehicles");
  assert.equal(calls.length, 3);
  const invalid = new InternalKbStore(async () => [Number.NaN]);
  await assert.rejects(invalid.ingest({ workspaceId, title: "bad", content: "invalid vector" }), /kb_embedding_invalid/);
});
