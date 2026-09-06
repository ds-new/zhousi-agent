import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PROFILE_PIN_GATE,
  resolveMcpPoolScope,
  resolveModelRoute,
  shouldWarmPool,
} from "../src/index.js";

describe("domain helpers", () => {
  it("resolveMcpPoolScope maps sensitivity to scope", () => {
    assert.equal(resolveMcpPoolScope({ serverName: "kb", transport: "stdio", sensitivity: "high" }), "session");
    assert.equal(resolveMcpPoolScope({ serverName: "kb", transport: "stdio", sensitivity: "readonly" }), "tenant");
    assert.equal(resolveMcpPoolScope({ serverName: "kb", transport: "stdio" }), "workspace");
  });

  it("shouldWarmPool disables high sensitivity", () => {
    assert.equal(shouldWarmPool({ serverName: "x", transport: "stdio", sensitivity: "high" }), false);
    assert.equal(shouldWarmPool({ serverName: "x", transport: "stdio" }), true);
  });

  it("resolveModelRoute enforces gateway allowlist and fallback", () => {
    const gateway = { allowedProviders: ["openai", "deepseek"] };
    assert.ok(resolveModelRoute(gateway, { provider: "openai", model: "gpt-4o-mini" }));
    assert.equal(resolveModelRoute(gateway, { provider: "google", model: "gemini" }), null);
    assert.equal(
      resolveModelRoute(gateway, {
        provider: "openai",
        model: "gpt-4o-mini",
        fallback: { provider: "google", model: "gemini" },
      }),
      null,
    );
  });

  it("DEFAULT_PROFILE_PIN_GATE matches spec thresholds", () => {
    assert.equal(DEFAULT_PROFILE_PIN_GATE.minPassRate, 0.85);
    assert.equal(DEFAULT_PROFILE_PIN_GATE.maxP95LatencyMs, 8000);
    assert.equal(DEFAULT_PROFILE_PIN_GATE.minToolSuccessRate, 0.9);
  });
});
