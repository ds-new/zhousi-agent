import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  evaluatePolicy,
  resetPoliciesForTests,
  setWorkspacePolicy,
} from "../src/index.js";

describe("dsh-policy-plugin", () => {
  beforeEach(() => resetPoliciesForTests());

  it("denies high-sensitivity tools by default", () => {
    const decision = evaluatePolicy("ws-1", {
      toolName: "mcp__prod__deploy",
      binding: { serverName: "prod", transport: "stdio", sensitivity: "high" },
      workspaceId: "ws-1",
    });
    assert.equal(decision.effect, "deny");
  });

  it("requires ask approval for high write tools", () => {
    const decision = evaluatePolicy("ws-1", {
      toolName: "mcp__prod__write_file",
      binding: { serverName: "prod", transport: "stdio", sensitivity: "high" },
      workspaceId: "ws-1",
    });
    assert.equal(decision.effect, "ask");
  });

  it("allows readonly tools by default", () => {
    const decision = evaluatePolicy("ws-1", {
      toolName: "mcp__kb__readonly_search",
      binding: { serverName: "kb", transport: "stdio", sensitivity: "readonly" },
      workspaceId: "ws-1",
    });
    assert.equal(decision.effect, "allow");
  });

  it("applies workspace policy overrides", () => {
    setWorkspacePolicy({
      workspaceId: "ws-2" as import("@diy-agent/domain").WorkspaceId,
      rules: [{ effect: "allow", toolPattern: "mcp__prod__*", sensitivity: "high" }],
    });
    const decision = evaluatePolicy("ws-2", {
      toolName: "mcp__prod__write",
      binding: { serverName: "prod", transport: "stdio", sensitivity: "high" },
      workspaceId: "ws-2",
    });
    assert.equal(decision.effect, "allow");
  });
});
