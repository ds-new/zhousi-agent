import { createHash } from "node:crypto";
import type { KbDocumentRegistryEntry } from "@diy-agent/domain";

export function computeKbContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** CP ingest response — registry metadata only, no document body. */
export function buildKbIngestResponse(
  registry: KbDocumentRegistryEntry,
): Record<string, unknown> {
  return {
    id: registry.id,
    workspaceId: registry.workspaceId,
    profileId: registry.profileId,
    title: registry.title,
    contentHash: registry.contentHash,
    createdAt: registry.createdAt,
  };
}
