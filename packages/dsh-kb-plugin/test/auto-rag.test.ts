import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { resetInternalIndexForTests } from "@diy-agent/kb-rag";
import {
  createKbRuntime,
  formatAutoRagContext,
  getAutoRagContext,
  resetAutoRagForTests,
  resetKbRuntimeForTests,
  runAutoRagOnTurnStart,
} from "../src/index.js";

describe("dsh-kb-plugin auto RAG", () => {
  beforeEach(() => {
    resetInternalIndexForTests();
    resetKbRuntimeForTests();
    resetAutoRagForTests();
  });

  it("formats top hits as system context", () => {
    const text = formatAutoRagContext([
      {
        documentId: "1",
        title: "Returns",
        snippet: "Refund within 30 days",
        score: 0.91,
        source: "internal",
      },
    ]);
    assert.match(text, /Returns/);
    assert.match(text, /Relevant knowledge base excerpts/);
  });

  it("injects auto RAG context on turn-start using last user message", async () => {
    const runtime = createKbRuntime();
    await runtime.ingest({
      workspaceId: "ws-auto" as import("@diy-agent/domain").WorkspaceId,
      title: "Returns",
      content: "Refund within 30 days of purchase.",
      kbConfig: { internal: { enabled: true }, retrievalMode: "auto" },
    });

    const context = await runAutoRagOnTurnStart(
      runtime,
      {
        sessionId: "sess-1",
        workspaceId: "ws-auto",
        userMessage: "refund policy",
      },
      { internal: { enabled: true }, retrievalMode: "auto" },
    );

    assert.ok(context);
    assert.match(context!, /Refund/);
    assert.equal(getAutoRagContext("sess-1"), context);
  });
});
