import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { flushTraces, getPendingTraces, resetTracesForTests } from "../src/index.js";

describe("dsh-trace-plugin", () => {
  beforeEach(() => resetTracesForTests());

  it("sends service account token when flushing traces", async () => {
    const pending = getPendingTraces();
    pending.push({
      profileId: "profile-1",
      profileVersionId: "version-1",
      output: "done",
      latencyMs: 42,
    });

    let authHeader: string | undefined;
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      authHeader = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ id: "trace-1" }), { status: 201 });
    };

    await flushTraces("http://127.0.0.1:9878", "diy_sa_test_token", fetchImpl as typeof fetch);
    assert.equal(authHeader, "Bearer diy_sa_test_token");
    assert.equal(getPendingTraces().length, 0);
  });
});
