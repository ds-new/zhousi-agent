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
