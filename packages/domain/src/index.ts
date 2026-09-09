/** Core domain types — vocabulary aligned with CONTEXT.md */

export type TenantId = string & { readonly __brand: "TenantId" };
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type ProfileId = string & { readonly __brand: "ProfileId" };
export type ProfileVersionId = string & { readonly __brand: "ProfileVersionId" };

export type GovernanceTier = "L0" | "L1" | "L2" | "L3";
export type WorkspaceRole = "admin" | "builder" | "user";
export type IsolationMode = "schema" | "dedicated";
export type McpPoolScope = "tenant" | "workspace" | "session";
export type SkillSource = "marketplace" | "private";
export type OrchestrationTopology = "supervisor" | "pipeline" | "blackboard";
export type EvolutionTrigger = "manual" | "signal" | "scheduled";
export type PolicyEffect = "allow" | "deny" | "ask";
export type McpApprovalStatus = "pending" | "approved" | "rejected";

export type KbRetrievalMode = "tool" | "auto";

export interface KnowledgeBaseConfig {
  internal?: { enabled: boolean; embeddingModel?: string };
  externalMcp?: McpBinding;
  fusionWeights?: { internal: number; external: number };
  /** Default: tool — LLM invokes kb_search; auto injects context on turn-start (Phase B). */
  retrievalMode?: KbRetrievalMode;
}

/** Control Plane metadata for an ingested KB document (no body on CP). */
export interface KbDocumentRegistryEntry {
  id: string;
  workspaceId: WorkspaceId;
  profileId: ProfileId;
  title: string;
  contentHash: string;
  createdAt: Date;
}

export interface OrchestrationConfig {
  topology: OrchestrationTopology;
  workerProfileIds?: ProfileId[];
}

export interface TenantGateway {
  allowedProviders: string[];
  rateLimitRpm?: number;
  fallbackProvider?: string;
  maxTokensPerDay?: number;
  maxWarmMcpConnections?: number;
  oidc?: {
    enabled: boolean;
    issuer?: string;
    audience?: string;
  };
}

export interface ProfilePinGate {
  minPassRate: number;
  maxP95LatencyMs: number;
  minToolSuccessRate?: number;
  maxTokensPerRun?: number;
}

export const DEFAULT_PROFILE_PIN_GATE: ProfilePinGate = {
  minPassRate: 0.85,
  maxP95LatencyMs: 8000,
  minToolSuccessRate: 0.9,
};

export const DEFAULT_EVOLUTION_SIGNAL_THRESHOLD = 0.75;
export const DEFAULT_MAX_WARM_MCP_CONNECTIONS = 10;
export const MIN_GOLDEN_TASKS_FOR_PIN = 5;
export const SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const EVAL_TRACE_RETENTION_DAYS = 90;
export const PROFILE_SYNC_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

export function isTraceExpired(createdAt: Date, now = new Date()): boolean {
  const cutoffMs = EVAL_TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return createdAt.getTime() < now.getTime() - cutoffMs;
}

export interface ProfileSyncEntry {
  profileId: ProfileId;
  versionId: ProfileVersionId;
  workspaceId: WorkspaceId;
  tenantId: TenantId;
  snapshot: Record<string, unknown>;
  policy: AccessPolicy;
  credentialRefIds: string[];
  mcpCatalog: McpCatalogEntry[];
  pinnedAt: Date;
}

/** Collect vault credential ref paths from profile model route and MCP bindings. */
export function collectCredentialRefIds(
  profile: Pick<AgentProfile, "modelRoute" | "mcpBindings">,
): string[] {
  const refs = new Set<string>();
  let route: ModelRoute | undefined = profile.modelRoute;
  while (route) {
    if (route.apiKeyRef) refs.add(route.apiKeyRef);
    route = route.fallback;
  }
  for (const binding of profile.mcpBindings) {
    if (binding.envRef) {
      for (const value of Object.values(binding.envRef)) refs.add(value);
    }
  }
  return [...refs];
}

/** Materialized Session Bootstrap config for Data Plane runtime enforcement. */
export interface ProfileBootstrapBundle {
  profileId: ProfileId;
  profileVersionId: ProfileVersionId;
  workspaceId: WorkspaceId;
  tenantId: TenantId;
  snapshot: Record<string, unknown>;
  policy: AccessPolicy;
  credentialRefIds: string[];
  mcpCatalog: McpCatalogEntry[];
  blockedMcpServers: string[];
  kbConfig?: KnowledgeBaseConfig;
  pinnedAt?: Date;
}

/** L3-protected paths — evolution must never mutate vault/credentials. */
export function isL3ProtectedMutationPath(path: string): boolean {
  return path.startsWith("vault/") || path.startsWith("credentials/");
}

export interface Tenant {
  id: TenantId;
  name: string;
  dbSchema: string;
  isolationMode: IsolationMode;
  dedicatedDatabaseUrl?: string;
  gateway: TenantGateway;
  createdAt: Date;
}

export interface Workspace {
  id: WorkspaceId;
  tenantId: TenantId;
  name: string;
  createdAt: Date;
}

export interface ModelRoute {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKeyRef?: string;
  fallback?: ModelRoute;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
}

export interface McpBinding {
  serverName: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
  envRef?: Record<string, string>;
  description?: string;
  warmPool?: boolean;
  poolScope?: McpPoolScope;
  sensitivity?: "normal" | "high" | "readonly";
}

export interface SkillBinding {
  skillId: string;
  source: SkillSource;
  workspaceId?: WorkspaceId;
}

export interface AgentProfile {
  id: ProfileId;
  workspaceId: WorkspaceId;
  name: string;
  systemPrompt: string;
  modelRoute: ModelRoute;
  skillIds: string[];
  skills?: SkillBinding[];
  mcpBindings: McpBinding[];
  orchestration?: OrchestrationConfig;
  kbConfig?: KnowledgeBaseConfig;
  governanceTier: GovernanceTier;
  pinnedVersionId?: ProfileVersionId;
}

export interface AgentProfileVersion {
  id: ProfileVersionId;
  profileId: ProfileId;
  version: number;
  snapshot: Omit<AgentProfile, "pinnedVersionId">;
  createdAt: Date;
  approvalStatus?: "pending" | "approved" | "rejected";
}

export interface Session {
  id: SessionId;
  workspaceId: WorkspaceId;
  profileId: ProfileId;
  profileVersionId: ProfileVersionId;
  title?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type MemoryKind = "fact" | "preference" | "procedure" | "episodic";

export interface MemoryEntry {
  id: string;
  workspaceId: WorkspaceId;
  kind: MemoryKind;
  content: string;
  sourceSessionId?: SessionId;
  embeddingRef?: string;
  ttl?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryGovernancePolicy {
  workspaceId: WorkspaceId;
  maxEntries: number;
  defaultTtlDays?: number;
  dedupSimilarityThreshold: number;
  compactionTriggerCount: number;
  asyncCompaction?: boolean;
}

export interface EvalTask {
  id: string;
  profileId: ProfileId;
  input: string;
  expectedContains?: string[];
  maxLatencyMs?: number;
}

export interface EvalResult {
  taskId: string;
  profileVersionId: ProfileVersionId;
  score: number;
  latencyMs: number;
  traceRef?: string;
  passed: boolean;
}

export interface EvolutionRun {
  id: string;
  profileId: ProfileId;
  baseVersionId: ProfileVersionId;
  candidateVersionId?: ProfileVersionId;
  tier: GovernanceTier;
  trigger: EvolutionTrigger;
  target: "skill" | "prompt" | "mcp_description";
  status: "running" | "completed" | "failed" | "awaiting_review" | "rejected";
  evalScoreDelta?: number;
  mutations?: import("./evolution-mutations.js").EvolutionMutation[];
  createdAt: Date;
}

export interface SkillCatalogEntry {
  id: string;
  tenantId: TenantId;
  workspaceId?: WorkspaceId;
  name: string;
  contentHash: string;
  source: SkillSource;
  marketplaceSkillId?: string;
  createdAt: Date;
}

/** Platform-published Skill available for tenant subscription (Phase 3). */
export interface MarketplaceSkill {
  id: string;
  slug: string;
  name: string;
  description?: string;
  contentHash: string;
  version: string;
  publishedAt: Date;
}

export interface MarketplaceSubscription {
  tenantId: TenantId;
  marketplaceSkillId: string;
  enabledAt: Date;
}

export interface SkillEvolutionTarget {
  source: SkillSource;
  workspaceId?: WorkspaceId;
}

/** L1 evolution may only mutate workspace-private Skills — not tenant-wide or marketplace Skills. */
export function isL1EvolutionSkillTargetAllowed(target: SkillEvolutionTarget): boolean {
  return target.source === "private" && target.workspaceId !== undefined;
}

export interface McpCatalogEntry {
  serverName: string;
  tenantId: TenantId;
  transport: McpBinding["transport"];
  command?: string;
  args?: string[];
  url?: string;
  defaultSensitivity: McpBinding["sensitivity"];
  approvalStatus: McpApprovalStatus;
  createdAt: Date;
}

export interface CredentialRefRecord {
  id: string;
  tenantId: TenantId;
  scope: string;
  createdBy: string;
  rotationAt?: Date;
  createdAt: Date;
}

export interface AccessPolicyRule {
  effect: PolicyEffect;
  toolPattern: string;
  sensitivity?: McpBinding["sensitivity"];
}

export interface AccessPolicy {
  workspaceId: WorkspaceId;
  rules: AccessPolicyRule[];
}

/** Tenant default deny-by-default for high-sensitivity MCP writes. */
export function defaultWorkspaceAccessPolicy(workspaceId: WorkspaceId): AccessPolicy {
  return {
    workspaceId,
    rules: [
      { effect: "allow", toolPattern: "*readonly*", sensitivity: "readonly" },
      { effect: "deny", toolPattern: "*", sensitivity: "high" },
      { effect: "ask", toolPattern: "*write*", sensitivity: "high" },
    ],
  };
}

export interface ProfileEvalRun {
  id: string;
  profileId: ProfileId;
  profileVersionId: ProfileVersionId;
  passRate: number;
  p95LatencyMs: number;
  toolSuccessRate: number;
  pinGatePassed: boolean;
  reasons: string[];
  createdAt: Date;
}

export interface AuditEvent {
  id: string;
  tenantId: TenantId;
  workspaceId?: WorkspaceId;
  action: string;
  actor?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface WebhookRegistration {
  id: string;
  tenantId: TenantId;
  url: string;
  events: string[];
  createdAt: Date;
}

export function resolveModelRoute(
  gateway: TenantGateway,
  profileRoute: ModelRoute,
): ModelRoute | null {
  if (!gateway.allowedProviders.includes(profileRoute.provider)) {
    return null;
  }
  if (profileRoute.fallback) {
    if (!gateway.allowedProviders.includes(profileRoute.fallback.provider)) {
      return null;
    }
  }
  return profileRoute;
}

export function resolveMcpPoolScope(binding: McpBinding): McpPoolScope {
  if (binding.poolScope) return binding.poolScope;
  if (binding.sensitivity === "high") return "session";
  if (binding.sensitivity === "readonly") return "tenant";
  return "workspace";
}

export function shouldWarmPool(binding: McpBinding): boolean {
  if (binding.sensitivity === "high") return false;
  return binding.warmPool ?? true;
}

export {
  applyEvolutionMutations,
  type EvolutionMutation,
} from "./evolution-mutations.js";
