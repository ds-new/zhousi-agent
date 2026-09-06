import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveMcpPoolScope,
  resolveModelRoute,
  type McpBinding,
  type TenantGateway,
} from "../src/index.js";

describe("domain policy", () => {
  const gateway: TenantGateway = {
    allowedProviders: ["deepseek", "openai"],
  };

  it("resolveModelRoute allows gateway-listed provider", () => {
    const route = resolveModelRoute(gateway, {
      provider: "deepseek",
      model: "deepseek-chat",
    });
    assert.ok(route);
    assert.equal(route!.provider, "deepseek");
  });

  it("resolveModelRoute rejects unlisted provider", () => {
    assert.equal(
      resolveModelRoute(gateway, { provider: "blocked", model: "x" }),
      null
    );
  });

  it("resolveMcpPoolScope maps sensitivity to scope", () => {
    const high: McpBinding = {
      serverName: "crm",
      transport: "stdio",
      sensitivity: "high",
    };
    const readonly: McpBinding = {
      serverName: "kb",
      transport: "streamable-http",
      url: "http://kb",
      sensitivity: "readonly",
    };
    assert.equal(resolveMcpPoolScope(high), "session");
    assert.equal(resolveMcpPoolScope(readonly), "tenant");
    assert.equal(
      resolveMcpPoolScope({ serverName: "x", transport: "stdio" }),
      "workspace"
    );
  });
});
