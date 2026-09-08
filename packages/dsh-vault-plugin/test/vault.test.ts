import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isL3ProtectedMutationPath } from "@diy-agent/domain";
import {
  decryptVault,
  encryptVault,
  deriveVaultKey,
  injectMcpEnv,
  resolveCredentialRef,
  setVaultSecret,
  apply,
} from "../src/index.js";

describe("dsh-vault-plugin", () => {
  it("encrypts and decrypts vault.enc with AES-256-GCM", () => {
    const key = deriveVaultKey("kms-test-key", "tenant-1");
    const blob = encryptVault({ "ref/github": "ghp_secret" }, key);
    const secrets = decryptVault(blob, key);
    assert.equal(secrets["ref/github"], "ghp_secret");
  });

  it("resolves credential refs and injects MCP env locally", () => {
    const vault = { "tenant/t1/mcp/github": "ghp_abc" };
    assert.equal(resolveCredentialRef(vault, "tenant/t1/mcp/github"), "ghp_abc");
    const env = injectMcpEnv(
      { GITHUB_TOKEN: "vault://tenant/t1/mcp/github" },
      vault,
    );
    assert.equal(env.GITHUB_TOKEN, "ghp_abc");
  });

  it("setVaultSecret updates encrypted store", () => {
    const key = deriveVaultKey("kms", "tenant-a");
    let blob = encryptVault({}, key);
    blob = setVaultSecret(blob, key, "tenant/a/openai", "sk-test");
    const secrets = decryptVault(blob, key);
    assert.equal(secrets["tenant/a/openai"], "sk-test");
  });

  it("blocks L3 protected mutation paths", () => {
    assert.equal(isL3ProtectedMutationPath("vault/tenant/x"), true);
    assert.equal(isL3ProtectedMutationPath("credentials/ref-1"), true);
    assert.equal(isL3ProtectedMutationPath("skills/0"), false);
  });

  it("lazy injects MCP env on tool/before-call", () => {
    const key = deriveVaultKey("kms", "tenant-a");
    const blob = encryptVault({ "tenant/t1/mcp/github": "ghp_abc" }, key);
    const handlers = new Map<string, (args: unknown) => void>();
    apply(
      {
        effect(fn) {
          fn();
        },
        on(event, handler) {
          handlers.set(event, handler);
        },
      },
      { kmsKeyMaterial: "kms", tenantId: "tenant-a", vaultEncBlob: blob },
    );

    const call = {
      toolName: "mcp__github__run",
      binding: {
        serverName: "github",
        transport: "stdio" as const,
        envRef: { GITHUB_TOKEN: "vault://tenant/t1/mcp/github" },
      },
    };
    handlers.get("tool/before-call")!(call);
    assert.equal(call.env?.GITHUB_TOKEN, "ghp_abc");
  });
});
