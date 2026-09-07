import type {
  AccessPolicy,
  AgentProfile,
  AgentProfileVersion,
  AuditEvent,
  CredentialRefRecord,
  EvalTask,
  EvolutionRun,
  GovernanceTier,
  McpCatalogEntry,
  ProfileId,
  SkillCatalogEntry,
  Tenant,
  TenantGateway,
  WebhookRegistration,
  Workspace,
  WorkspaceId,
  WorkspaceRole,
} from "@diy-agent/domain";
import type { ApiKeyRecord, WorkspaceMemberRecord } from "@diy-agent/auth";

export interface CreateTenantInput {
  name: string;
  dbSchema?: string;
  isolationMode?: Tenant["isolationMode"];
  gateway?: Partial<TenantGateway>;
}

export interface CreateWorkspaceInput {
  tenantId: Tenant["id"];
  name?: string;
  creatorUserId?: string;
}

export interface ApproveEvolutionInput {
  runId: string;
  tenantId: Tenant["id"];
  reviewer: string;
  candidateVersionId?: AgentProfileVersion["id"];
}

export interface RejectEvolutionInput {
  runId: string;
  tenantId: Tenant["id"];
  reviewer: string;
  reason?: string;
}

export interface CreateProfileInput {
  workspaceId: Workspace["id"];
  tenantId: Tenant["id"];
  profile: Partial<AgentProfile>;
}

export interface CreateSessionInput {
  profileId: ProfileId;
  tenantId: Tenant["id"];
}

export interface CreateEvolutionRunInput {
  profileId: ProfileId;
  tenantId: Tenant["id"];
  trigger: EvolutionRun["trigger"];
  target?: EvolutionRun["target"];
  tier?: GovernanceTier;
}

export interface TriggerEvolutionSignalInput {
  profileId: ProfileId;
  tenantId: Tenant["id"];
  passRate: number;
  threshold?: number;
}

export interface EvalTraceRecord {
  id: string;
  profileId: ProfileId;
  profileVersionId: AgentProfileVersion["id"];
  output: string;
  latencyMs: number;
  toolCalls?: Array<{ name: string; ok: boolean }>;
  tokensUsed?: number;
  createdAt: Date;
}

export interface SessionCreateResult {
  session: import("@diy-agent/domain").Session;
  dshMeta: Record<string, string>;
  sessionToken: string;
  sessionTokenExpiresAt: Date;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  tokensUsedToday?: number;
  warning?: boolean;
}

export interface ControlPlaneStore {
  createTenant(input: CreateTenantInput): Promise<Tenant>;
  getTenant(id: Tenant["id"]): Promise<Tenant | null>;
  updateTenantGateway(id: Tenant["id"], gateway: TenantGateway): Promise<Tenant | null>;
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace | null>;
  createProfile(input: CreateProfileInput): Promise<{
    profile: AgentProfile;
    version: AgentProfileVersion;
  } | null>;
  getProfile(id: ProfileId): Promise<AgentProfile | null>;
  getTenantForProfile(profileId: ProfileId): Promise<Tenant | null>;
  getProfileVersion(
    profileId: ProfileId,
    versionId: AgentProfileVersion["id"],
  ): Promise<AgentProfileVersion | null>;
  getLatestProfileVersion(profileId: ProfileId): Promise<AgentProfileVersion | null>;
  pinProfile(
    profileId: ProfileId,
    versionId: AgentProfileVersion["id"],
  ): Promise<AgentProfile | null>;
  createSession(input: CreateSessionInput): Promise<SessionCreateResult | null>;
  checkSessionQuota(tenantId: Tenant["id"]): Promise<QuotaCheckResult>;
  recordTokenUsage(tenantId: Tenant["id"], tokens: number): Promise<QuotaCheckResult>;
  createGoldenTask(task: Omit<EvalTask, "id">): Promise<EvalTask>;
  listGoldenTasks(profileId: ProfileId): Promise<EvalTask[]>;
  saveTrace(trace: Omit<EvalTraceRecord, "id" | "createdAt">): Promise<EvalTraceRecord>;
  listTraces(profileId: ProfileId, limit?: number): Promise<EvalTraceRecord[]>;
  registerSkill(entry: Omit<SkillCatalogEntry, "id" | "createdAt">): Promise<SkillCatalogEntry>;
  listSkills(tenantId: Tenant["id"], workspaceId?: Workspace["id"]): Promise<SkillCatalogEntry[]>;
  registerMcp(entry: Omit<McpCatalogEntry, "createdAt">): Promise<McpCatalogEntry>;
  approveMcp(tenantId: Tenant["id"], serverName: string): Promise<McpCatalogEntry | null>;
  listMcp(tenantId: Tenant["id"]): Promise<McpCatalogEntry[]>;
  registerCredentialRef(
    entry: Omit<CredentialRefRecord, "id" | "createdAt">,
  ): Promise<CredentialRefRecord>;
  appendAudit(event: Omit<AuditEvent, "id" | "createdAt">): Promise<AuditEvent>;
  listAuditLog(tenantId: Tenant["id"], limit?: number): Promise<AuditEvent[]>;
  listProfileSyncEntries(tenantId: Tenant["id"]): Promise<import("@diy-agent/domain").ProfileSyncEntry[]>;
  registerWebhook(
    entry: Omit<WebhookRegistration, "id" | "createdAt">,
  ): Promise<WebhookRegistration>;
  listWebhooks(tenantId: Tenant["id"]): Promise<WebhookRegistration[]>;
  consumeQuotaWarningDispatch(tenantId: Tenant["id"]): Promise<boolean>;
  createEvolutionRun(input: CreateEvolutionRunInput): Promise<EvolutionRun | null>;
  getEvolutionRun(id: string): Promise<EvolutionRun | null>;
  triggerEvolutionSignal(
    input: TriggerEvolutionSignalInput,
  ): Promise<EvolutionRun | { skipped: true; reason: string }>;
  approveEvolutionRun(input: ApproveEvolutionInput): Promise<EvolutionRun | null>;
  rejectEvolutionRun(input: RejectEvolutionInput): Promise<EvolutionRun | null>;
  createApiKey(tenantId: Tenant["id"], name: string): Promise<{ key: string; record: ApiKeyRecord }>;
  listApiKeys(tenantId: Tenant["id"]): Promise<ApiKeyRecord[]>;
  listAllApiKeys(): Promise<ApiKeyRecord[]>;
  addWorkspaceMember(
    workspaceId: WorkspaceId,
    userId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMemberRecord>;
  getWorkspaceMember(
    workspaceId: WorkspaceId,
    userId: string,
  ): Promise<WorkspaceMemberRecord | null>;
  setWorkspacePolicy(policy: AccessPolicy): Promise<AccessPolicy>;
  getWorkspacePolicy(workspaceId: WorkspaceId): Promise<AccessPolicy | null>;
  close?(): Promise<void>;
}

export function defaultGateway(overrides?: Partial<TenantGateway>): TenantGateway {
  return {
    allowedProviders: ["openai", "deepseek", "anthropic"],
    rateLimitRpm: 600,
    maxTokensPerDay: 1_000_000,
    maxWarmMcpConnections: 10,
    ...overrides,
  };
}
