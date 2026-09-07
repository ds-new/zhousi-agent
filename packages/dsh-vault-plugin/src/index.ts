/**
 * Data Plane credential vault — encrypted vault.enc per tenant (AES-256-GCM).
 * Control Plane stores refs only; plaintext never leaves Data Plane.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { isL3ProtectedMutationPath } from "@diy-agent/domain";

export const name = "@diy-agent/dsh-vault-plugin";
export const inject = ["tools"] as const;

export interface EncryptedVaultBlob {
  iv: string;
  tag: string;
  data: string;
}

export function deriveVaultKey(kmsKeyMaterial: string, tenantId: string): Buffer {
  return scryptSync(kmsKeyMaterial, tenantId, 32);
}

export function encryptVault(secrets: Record<string, string>, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(secrets);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob: EncryptedVaultBlob = {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
  return JSON.stringify(blob);
}

export function decryptVault(blobJson: string, key: Buffer): Record<string, string> {
  const blob = JSON.parse(blobJson) as EncryptedVaultBlob;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(blob.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as Record<string, string>;
}

export function resolveCredentialRef(
  vault: Record<string, string>,
  refId: string,
): string | null {
  return vault[refId] ?? null;
}

export function injectMcpEnv(
  envRef: Record<string, string>,
  vault: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [envKey, refPath] of Object.entries(envRef)) {
    const refId = refPath.replace(/^vault:\/\//, "");
    const secret = resolveCredentialRef(vault, refId);
    if (secret) env[envKey] = secret;
  }
  return env;
}

export function setVaultSecret(
  blobJson: string,
  key: Buffer,
  refId: string,
  value: string,
): string {
  const secrets = blobJson ? decryptVault(blobJson, key) : {};
  secrets[refId] = value;
  return encryptVault(secrets, key);
}

export function assertEvolutionMutationAllowed(mutationPath: string): void {
  if (isL3ProtectedMutationPath(mutationPath)) {
    throw new Error("evolution_l3_vault_forbidden");
  }
}

export function apply(_ctx: unknown, config: { kmsKeyMaterial?: string; tenantId?: string }): void {
  void config;
}
