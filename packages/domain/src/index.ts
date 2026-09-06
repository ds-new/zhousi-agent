/** Core domain types — vocabulary aligned with CONTEXT.md */

export type TenantId = string & { readonly __brand: "TenantId" };
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type ProfileId = string & { readonly __brand: "ProfileId" };
export type ProfileVersionId = string & { readonly __brand: "ProfileVersionId" };

export type GovernanceTier = "L0" | "L1" | "L2" | "L3";

export type IsolationMode = "schema" | "dedicated";

export type McpPoolScope = "tenant" | "workspace" | "session";

export type SkillSource = "marketplace" | "private";

export type OrchestrationTopology = "supervisor" | "pipeline" | "blackboard";

export type EvolutionTrigger = "manual" | "signal" | "scheduled";

export interface KnowledgeBaseConfig {
  internal?: {
    enabled: boolean;
    embeddingModel?: string;
  };
  externalMcp?: McpBinding;
}

export interface OrchestrationConfig {
  topology: OrchestrationTopology;
  /** Worker profile IDs for supervisor / pipeline stages */
  workerProfileIds?: ProfileId[];
}

export interface TenantGateway {
  allowedProviders: string[];
  rateLimitRpm?: number;
  fallbackProvider?: string;
  maxTokensPerDay?: number;
}

export interface ProfilePinGate {
  minPassRate: number;
  maxP95LatencyMs: number;
  minToolSuccessRate?: number;
  maxTokensPerRun?: number;
}

export const DEFAULT_PROFILE_PIN_GATE: ProfilePinGate = {
  minPassRate: 0.8,
  maxP95LatencyMs: 5000,
};

export interface Tenant {
  id: TenantId;
  name: string;
  /** Each tenant owns an isolated DB schema or connection string */
  dbSchema: string;
  isolationMode: IsolationMode;
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
  /** Custom endpoint override, e.g. private vLLM */
  baseUrl?: string;
  apiKeyRef?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
}

export interface McpBinding {
  serverName: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
  envRef?: Record<string, string>;
  /** Warm pool: keep process alive between turns */
  warmPool?: boolean;
  /** Default workspace; session for sensitive; tenant for read-only KB */
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
  /** L2+ changes require approval before pin */
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

/** L0 self-governance: TTL → dedup → compaction */
export interface MemoryGovernancePolicy {
  workspaceId: WorkspaceId;
  maxEntries: number;
  defaultTtlDays?: number;
  dedupSimilarityThreshold: number;
  compactionTriggerCount: number;
  /** Run compaction asynchronously after turn */
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

export function resolveModelRoute(
  gateway: TenantGateway,
  profileRoute: ModelRoute
): ModelRoute | null {
  if (!gateway.allowedProviders.includes(profileRoute.provider)) {
    return null;
  }
  return profileRoute;
}

export function resolveMcpPoolScope(binding: McpBinding): McpPoolScope {
  if (binding.poolScope) return binding.poolScope;
  if (binding.sensitivity === "high") return "session";
  if (binding.sensitivity === "readonly") return "tenant";
  return "workspace";
}

export interface EvolutionRun {
  id: string;
  profileId: ProfileId;
  baseVersionId: ProfileVersionId;
  candidateVersionId?: ProfileVersionId;
  tier: GovernanceTier;
  trigger: EvolutionTrigger;
  target: "skill" | "prompt" | "mcp_description";
  status: "running" | "completed" | "failed" | "awaiting_review";
  evalScoreDelta?: number;
  createdAt: Date;
}

export const DEFAULT_EVOLUTION_SIGNAL_THRESHOLD = 0.75;
