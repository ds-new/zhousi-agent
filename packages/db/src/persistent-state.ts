/** Serializable catalog state. Entries are partitioned into the owner's database/schema. */
export const STATE_MAPS = ["workspaces", "profiles", "profileVersions", "sessions", "evolutionRuns", "goldenTasks", "traces", "skills",
  "marketplaceSubscriptions", "mcpCatalog", "credentialRefs", "apiKeys", "workspaceMembers", "workspacePolicies", "profileEvalRuns",
  "kbDocumentRegistry", "webhooks", "sessionTokens", "tokenUsageByTenant", "rateWindows", "usageEvents"] as const;

export interface StoreState {
  maps: Record<string, Array<[string, unknown]>>;
  warnings: string[];
}

export function decodeState(raw: unknown): StoreState {
  return JSON.parse(JSON.stringify(raw), (key, value) =>
    typeof value === "string" && /(?:At|ttl)$/.test(key) && /^\d{4}-\d\d-\d\dT/.test(value) ? new Date(value) : value);
}
