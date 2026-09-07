import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PROFILE_PIN_GATE,
  EVAL_TRACE_RETENTION_DAYS,
  isL1EvolutionSkillTargetAllowed,
  isTraceExpired,
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

  it("isTraceExpired enforces 90-day retention", () => {
    assert.equal(EVAL_TRACE_RETENTION_DAYS, 90);
    const now = new Date("2026-01-01T00:00:00Z");
    assert.equal(isTraceExpired(new Date("2025-12-01T00:00:00Z"), now), false);
    assert.equal(isTraceExpired(new Date("2025-09-01T00:00:00Z"), now), true);
  });

  it("isL1EvolutionSkillTargetAllowed restricts to workspace-private skills", () => {
    assert.equal(
      isL1EvolutionSkillTargetAllowed({ source: "private", workspaceId: "ws-1" as never }),
      true,
    );
    assert.equal(isL1EvolutionSkillTargetAllowed({ source: "private" }), false);
    assert.equal(isL1EvolutionSkillTargetAllowed({ source: "marketplace" }), false);
  });
});
