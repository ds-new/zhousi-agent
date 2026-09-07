import {
  DEFAULT_EVOLUTION_SIGNAL_THRESHOLD,
  SESSION_TOKEN_TTL_MS,
  defaultWorkspaceAccessPolicy,
  isTraceExpired,
  isL1EvolutionSkillTargetAllowed,
  resolveModelRoute,
  type AgentProfile,
  type AgentProfileVersion,
  type AuditEvent,
  type CredentialRefRecord,
  type EvalTask,
  type EvolutionRun,
  type McpCatalogEntry,
  type ProfileSyncEntry,
  type ProfileId,
  type ProfileEvalRun,
  type SkillCatalogEntry,
  type KbDocumentRegistryEntry,
  type MarketplaceSkill,
  type MarketplaceSubscription,
  type SkillEvolutionTarget,
  type Tenant,
  type TenantGateway,
  type WebhookRegistration,
} from "@diy-agent/domain";
import type {
  ControlPlaneStore,
  CreateEvolutionRunInput,
  ApproveEvolutionInput,
  RejectEvolutionInput,
  CreateProfileInput,
  CreateSessionInput,
  CreateTenantInput,
  CreateWorkspaceInput,
  EvalTraceRecord,
  PublishMarketplaceSkillInput,
  QuotaCheckResult,
  SessionCreateResult,
  TriggerEvolutionSignalInput,
} from "./types.js";
import { defaultGateway } from "./types.js";
import { generateApiKey, type ApiKeyRecord, type WorkspaceMemberRecord } from "@diy-agent/auth";
import type { AccessPolicy, WorkspaceId, WorkspaceRole } from "@diy-agent/domain";

interface RateWindow {
  count: number;
  windowStart: number;
}

export class MemoryStore implements ControlPlaneStore {
  protected tenants = new Map<string, Tenant>();
  protected workspaces = new Map<string, import("@diy-agent/domain").Workspace>();
  protected profiles = new Map<string, AgentProfile>();
  protected profileVersions = new Map<string, AgentProfileVersion>();
  protected sessions = new Map<string, import("@diy-agent/domain").Session>();
  protected evolutionRuns = new Map<string, EvolutionRun>();
  protected goldenTasks = new Map<string, EvalTask>();
  protected traces = new Map<string, EvalTraceRecord>();
  protected skills = new Map<string, SkillCatalogEntry>();
  protected marketplaceSkills = new Map<string, MarketplaceSkill>();
  protected marketplaceSubscriptions = new Map<string, MarketplaceSubscription>();
  protected mcpCatalog = new Map<string, McpCatalogEntry>();
  protected credentialRefs = new Map<string, CredentialRefRecord>();
  protected auditLog: AuditEvent[] = [];
  protected quotaWarningsDispatched = new Set<string>();
  protected apiKeys = new Map<string, ApiKeyRecord>();
  protected workspaceMembers = new Map<string, WorkspaceMemberRecord>();
  protected workspacePolicies = new Map<string, AccessPolicy>();
  protected profileEvalRuns = new Map<string, ProfileEvalRun>();
  protected kbDocumentRegistry = new Map<string, KbDocumentRegistryEntry>();
  protected webhooks = new Map<string, WebhookRegistration>();
  protected sessionTokens = new Map<string, { workspaceId: string; expiresAt: number }>();
  protected tokenUsageByTenant = new Map<string, { day: string; tokens: number }>();
  protected rateWindows = new Map<string, RateWindow>();

  async getProfile(id: ProfileId): Promise<AgentProfile | null> {
    return this.profiles.get(id) ?? null;
  }

  async getTenantForProfile(profileId: ProfileId): Promise<Tenant | null> {
    const profile = this.profiles.get(profileId);
    if (!profile) return null;
    const ws = this.workspaces.get(profile.workspaceId);
    if (!ws) return null;
    return this.tenants.get(ws.tenantId) ?? null;
  }

  async getProfileVersion(
    profileId: ProfileId,
    versionId: AgentProfileVersion["id"],
  ): Promise<AgentProfileVersion | null> {
    const version = this.profileVersions.get(versionId);
    if (!version || version.profileId !== profileId) return null;
    return version;
  }

  async getLatestProfileVersion(profileId: ProfileId): Promise<AgentProfileVersion | null> {
    const versions = [...this.profileVersions.values()].filter((v) => v.profileId === profileId);
    if (versions.length === 0) return null;
    return versions.sort((a, b) => b.version - a.version)[0] ?? null;
  }

  async pinProfile(
    profileId: ProfileId,
    versionId: AgentProfileVersion["id"],
  ): Promise<AgentProfile | null> {
    const profile = this.profiles.get(profileId);
    const version = this.profileVersions.get(versionId);
    if (!profile || !version || version.profileId !== profileId) return null;
    profile.pinnedVersionId = versionId;
    return profile;
  }

  async createTenant(input: CreateTenantInput): Promise<Tenant> {
    const id = crypto.randomUUID() as Tenant["id"];
    const tenant: Tenant = {
      id,
      name: input.name ?? "unnamed",
      dbSchema: input.dbSchema ?? `tenant_${id.slice(0, 8)}`,
      isolationMode: input.isolationMode ?? "schema",
      gateway: defaultGateway(input.gateway),
      createdAt: new Date(),
    };
    this.tenants.set(id, tenant);
    return tenant;
  }

  async getTenant(id: Tenant["id"]): Promise<Tenant | null> {
    return this.tenants.get(id) ?? null;
  }

  async updateTenantGateway(id: Tenant["id"], gateway: TenantGateway): Promise<Tenant | null> {
    const tenant = this.tenants.get(id);
    if (!tenant) return null;
    tenant.gateway = gateway;
    return tenant;
  }

  async createWorkspace(input: CreateWorkspaceInput) {
    if (!this.tenants.has(input.tenantId)) return null;
    const id = crypto.randomUUID() as import("@diy-agent/domain").Workspace["id"];
    const ws = {
      id,
      tenantId: input.tenantId,
      name: input.name ?? "default",
      createdAt: new Date(),
    };
    this.workspaces.set(id, ws);
    await this.setWorkspacePolicy(defaultWorkspaceAccessPolicy(id));
    if (input.creatorUserId) {
      await this.addWorkspaceMember(id, input.creatorUserId, "admin");
    }
    return ws;
  }

  async createProfile(input: CreateProfileInput) {
    if (!this.workspaces.has(input.workspaceId)) return null;
    const tenant = this.tenants.get(input.tenantId);
    if (!tenant) return null;

    const body = input.profile;
    const modelRoute = body.modelRoute ?? {
      provider: "openai",
      model: "gpt-4o-mini",
    };
    if (!resolveModelRoute(tenant.gateway, modelRoute)) {
      throw new Error("model_provider_not_allowed");
    }

    const profileId = crypto.randomUUID() as ProfileId;
    const profile: AgentProfile = {
      id: profileId,
      workspaceId: input.workspaceId,
      name: body.name ?? "default-profile",
      systemPrompt: body.systemPrompt ?? "You are a helpful assistant.",
      modelRoute,
      skillIds: body.skillIds ?? [],
      skills: body.skills,
      mcpBindings: body.mcpBindings ?? [],
      orchestration: body.orchestration,
      kbConfig: body.kbConfig,
      governanceTier: body.governanceTier ?? "L1",
    };

    const versionId = crypto.randomUUID() as AgentProfileVersion["id"];
    const version: AgentProfileVersion = {
      id: versionId,
      profileId,
      version: 1,
      snapshot: { ...profile },
      createdAt: new Date(),
      approvalStatus: "approved",
    };
    profile.pinnedVersionId = undefined;
    this.profiles.set(profileId, profile);
    this.profileVersions.set(versionId, version);
    return { profile, version };
  }

  async checkSessionQuota(tenantId: Tenant["id"]): Promise<QuotaCheckResult> {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return { allowed: false, reason: "tenant_not_found" };

    const rate = this.checkRateLimit(tenantId, tenant.gateway.rateLimitRpm ?? 600);
    if (!rate.allowed) return rate;

    const usage = this.getTokenUsage(tenantId);
    const max = tenant.gateway.maxTokensPerDay;
    if (max !== undefined && usage.tokens >= max) {
      return { allowed: false, reason: "daily_token_quota_exceeded", tokensUsedToday: usage.tokens };
    }
    if (max !== undefined && usage.tokens >= max * 0.8) {
      return { allowed: true, warning: true, tokensUsedToday: usage.tokens };
    }
    return { allowed: true, tokensUsedToday: usage.tokens };
  }

  async recordTokenUsage(tenantId: Tenant["id"], tokens: number): Promise<QuotaCheckResult> {
    const usage = this.getTokenUsage(tenantId);
    usage.tokens += tokens;
    this.tokenUsageByTenant.set(tenantId, usage);
    return this.checkSessionQuota(tenantId);
  }

  async createSession(input: CreateSessionInput): Promise<SessionCreateResult | null> {
    const quota = await this.checkSessionQuota(input.tenantId);
    if (!quota.allowed) return null;

    const profile = this.profiles.get(input.profileId);
    if (!profile?.pinnedVersionId) return null;

    const ws = this.workspaces.get(profile.workspaceId);
    if (!ws || ws.tenantId !== input.tenantId) return null;

    const sessionId = crypto.randomUUID() as import("@diy-agent/domain").Session["id"];
    const now = new Date();
    const session = {
      id: sessionId,
      workspaceId: profile.workspaceId,
      profileId: profile.id,
      profileVersionId: profile.pinnedVersionId,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);

    const sessionToken = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
    const expiresAt = Date.now() + SESSION_TOKEN_TTL_MS;
    this.sessionTokens.set(sessionToken, {
      workspaceId: profile.workspaceId,
      expiresAt,
    });

    await this.appendAudit({
      tenantId: input.tenantId,
      workspaceId: profile.workspaceId,
      action: "session.created",
      metadata: {
        sessionId,
        profileId: profile.id,
        profileVersionId: profile.pinnedVersionId,
      },
    });

    return {
      session,
      dshMeta: {
        "diy.tenantId": ws.tenantId,
        "diy.workspaceId": ws.id,
        "diy.profileId": profile.id,
        "diy.profileVersionId": profile.pinnedVersionId,
      },
      sessionToken,
      sessionTokenExpiresAt: new Date(expiresAt),
    };
  }

  async createGoldenTask(task: Omit<EvalTask, "id">): Promise<EvalTask> {
    const entry: EvalTask = { ...task, id: crypto.randomUUID() };
    this.goldenTasks.set(entry.id, entry);
    return entry;
  }

  async listGoldenTasks(profileId: ProfileId): Promise<EvalTask[]> {
    return [...this.goldenTasks.values()].filter((t) => t.profileId === profileId);
  }

  async saveTrace(trace: Omit<EvalTraceRecord, "id" | "createdAt">): Promise<EvalTraceRecord> {
    this.purgeExpiredTraces();
    const entry: EvalTraceRecord = {
      ...trace,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    this.traces.set(entry.id, entry);
    return entry;
  }

  protected purgeExpiredTraces(now = new Date()): void {
    for (const [id, trace] of this.traces) {
      if (isTraceExpired(trace.createdAt, now)) {
        this.traces.delete(id);
      }
    }
  }

  async listTraces(profileId: ProfileId, limit = 50): Promise<EvalTraceRecord[]> {
    return [...this.traces.values()]
      .filter((t) => t.profileId === profileId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async registerSkill(
    entry: Omit<SkillCatalogEntry, "id" | "createdAt">,
  ): Promise<SkillCatalogEntry> {
    const skill: SkillCatalogEntry = {
      ...entry,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    this.skills.set(skill.id, skill);
    return skill;
  }

  async listSkills(
    tenantId: Tenant["id"],
    workspaceId?: import("@diy-agent/domain").Workspace["id"],
  ): Promise<SkillCatalogEntry[]> {
    const catalog = [...this.skills.values()].filter(
      (s) =>
        s.tenantId === tenantId &&
        (workspaceId === undefined || s.workspaceId === undefined || s.workspaceId === workspaceId),
    );
    const subscribed = [...this.marketplaceSubscriptions.values()]
      .filter((sub) => sub.tenantId === tenantId)
      .map((sub) => this.marketplaceSkills.get(sub.marketplaceSkillId))
      .filter((skill): skill is MarketplaceSkill => skill !== undefined)
      .map(
        (skill): SkillCatalogEntry => ({
          id: skill.id,
          tenantId,
          name: skill.name,
          contentHash: skill.contentHash,
          source: "marketplace",
          marketplaceSkillId: skill.id,
          createdAt: skill.publishedAt,
        }),
      );
    return [...catalog, ...subscribed];
  }

  async resolveSkillEvolutionTarget(
    tenantId: Tenant["id"],
    workspaceId: WorkspaceId,
    skillId: string,
  ): Promise<SkillEvolutionTarget | null> {
    const catalogSkill = this.skills.get(skillId);
    if (catalogSkill && catalogSkill.tenantId === tenantId) {
      return { source: catalogSkill.source, workspaceId: catalogSkill.workspaceId };
    }
    const marketplaceSkill = this.marketplaceSkills.get(skillId);
    if (marketplaceSkill) {
      const key = `${tenantId}:${skillId}`;
      if (this.marketplaceSubscriptions.has(key)) {
        return { source: "marketplace" };
      }
    }
    return null;
  }

  async publishMarketplaceSkill(input: PublishMarketplaceSkillInput): Promise<MarketplaceSkill> {
    const skill: MarketplaceSkill = {
      id: crypto.randomUUID(),
      slug: input.slug,
      name: input.name,
      description: input.description,
      contentHash: input.contentHash,
      version: input.version ?? "1.0.0",
      publishedAt: new Date(),
    };
    this.marketplaceSkills.set(skill.id, skill);
    return skill;
  }

  async listMarketplaceSkills(): Promise<MarketplaceSkill[]> {
    return [...this.marketplaceSkills.values()].sort(
      (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
    );
  }

  async getMarketplaceSkill(id: string): Promise<MarketplaceSkill | null> {
    return this.marketplaceSkills.get(id) ?? null;
  }

  async subscribeMarketplaceSkill(
    tenantId: Tenant["id"],
    marketplaceSkillId: string,
  ): Promise<MarketplaceSubscription> {
    const skill = this.marketplaceSkills.get(marketplaceSkillId);
    if (!skill) throw new Error("marketplace_skill_not_found");
    const subscription: MarketplaceSubscription = {
      tenantId,
      marketplaceSkillId,
      enabledAt: new Date(),
    };
    this.marketplaceSubscriptions.set(`${tenantId}:${marketplaceSkillId}`, subscription);
    await this.appendAudit({
      tenantId,
      action: "marketplace.skill_subscribed",
      metadata: { marketplaceSkillId, slug: skill.slug },
    });
    return subscription;
  }

  async unsubscribeMarketplaceSkill(
    tenantId: Tenant["id"],
    marketplaceSkillId: string,
  ): Promise<boolean> {
    return this.marketplaceSubscriptions.delete(`${tenantId}:${marketplaceSkillId}`);
  }

  async listMarketplaceSubscriptions(tenantId: Tenant["id"]): Promise<MarketplaceSubscription[]> {
    return [...this.marketplaceSubscriptions.values()].filter((sub) => sub.tenantId === tenantId);
  }

  async registerMcp(entry: Omit<McpCatalogEntry, "createdAt">): Promise<McpCatalogEntry> {
    const key = `${entry.tenantId}:${entry.serverName}`;
    const mcp: McpCatalogEntry = { ...entry, createdAt: new Date() };
    this.mcpCatalog.set(key, mcp);
    return mcp;
  }

  async approveMcp(tenantId: Tenant["id"], serverName: string): Promise<McpCatalogEntry | null> {
    const key = `${tenantId}:${serverName}`;
    const entry = this.mcpCatalog.get(key);
    if (!entry) return null;
    entry.approvalStatus = "approved";
    return entry;
  }

  async listMcp(tenantId: Tenant["id"]): Promise<McpCatalogEntry[]> {
    return [...this.mcpCatalog.values()].filter((m) => m.tenantId === tenantId);
  }

  async registerCredentialRef(
    entry: Omit<CredentialRefRecord, "id" | "createdAt">,
  ): Promise<CredentialRefRecord> {
    const ref: CredentialRefRecord = {
      ...entry,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    this.credentialRefs.set(ref.id, ref);
    await this.appendAudit({
      tenantId: entry.tenantId,
      action: "vault.credential_rotated",
      actor: entry.createdBy,
      metadata: { scope: entry.scope, refId: ref.id },
    });
    return ref;
  }

  async appendAudit(event: Omit<AuditEvent, "id" | "createdAt">): Promise<AuditEvent> {
    const record: AuditEvent = {
      ...event,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    this.auditLog.push(record);
    return record;
  }

  async listAuditLog(tenantId: Tenant["id"], limit = 100): Promise<AuditEvent[]> {
    const events = this.auditLog.filter((entry) => entry.tenantId === tenantId);
    return events.slice(-limit).reverse();
  }

  async listProfileSyncEntries(tenantId: Tenant["id"]): Promise<ProfileSyncEntry[]> {
    const workspaceIds = new Set(
      [...this.workspaces.values()].filter((ws) => ws.tenantId === tenantId).map((ws) => ws.id),
    );
    const entries: ProfileSyncEntry[] = [];
    for (const profile of this.profiles.values()) {
      if (!workspaceIds.has(profile.workspaceId) || !profile.pinnedVersionId) continue;
      const version = this.profileVersions.get(profile.pinnedVersionId);
      if (!version) continue;
      entries.push({
        profileId: profile.id,
        versionId: profile.pinnedVersionId,
        snapshot: version.snapshot as unknown as Record<string, unknown>,
        pinnedAt: version.createdAt,
      });
    }
    return entries;
  }

  async registerWebhook(
    entry: Omit<WebhookRegistration, "id" | "createdAt">,
  ): Promise<WebhookRegistration> {
    const hook: WebhookRegistration = {
      ...entry,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    this.webhooks.set(hook.id, hook);
    return hook;
  }

  async listWebhooks(tenantId: Tenant["id"]): Promise<WebhookRegistration[]> {
    return [...this.webhooks.values()].filter((hook) => hook.tenantId === tenantId);
  }

  async consumeQuotaWarningDispatch(tenantId: Tenant["id"]): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${tenantId}:${day}`;
    if (this.quotaWarningsDispatched.has(key)) return false;
    this.quotaWarningsDispatched.add(key);
    return true;
  }

  async createEvolutionRun(input: CreateEvolutionRunInput): Promise<EvolutionRun | null> {
    const profile = this.profiles.get(input.profileId);
    if (!profile) return null;
    const baseVersionId =
      profile.pinnedVersionId ?? (await this.getLatestProfileVersion(input.profileId))?.id;
    if (!baseVersionId) return null;
    const ws = this.workspaces.get(profile.workspaceId);
    if (!ws || ws.tenantId !== input.tenantId) return null;

    const tier = input.tier ?? profile.governanceTier;
    if (tier === "L3") throw new Error("evolution_tier_forbidden");

    let target = input.target ?? "skill";
    if (target === "skill" && tier === "L1") {
      if (!input.skillId) {
        target = "mcp_description";
      } else {
        const skillTarget = await this.resolveSkillEvolutionTarget(
          input.tenantId,
          profile.workspaceId,
          input.skillId,
        );
        if (!skillTarget || !isL1EvolutionSkillTargetAllowed(skillTarget)) {
          throw new Error("evolution_skill_not_mutable");
        }
      }
    }

    const run: EvolutionRun = {
      id: crypto.randomUUID(),
      profileId: profile.id,
      baseVersionId,
      tier,
      trigger: input.trigger,
      target,
      status: tier === "L2" ? "awaiting_review" : "running",
      createdAt: new Date(),
    };
    this.evolutionRuns.set(run.id, run);
    return run;
  }

  async getEvolutionRun(id: string): Promise<EvolutionRun | null> {
    return this.evolutionRuns.get(id) ?? null;
  }

  async triggerEvolutionSignal(input: TriggerEvolutionSignalInput) {
    const threshold = input.threshold ?? DEFAULT_EVOLUTION_SIGNAL_THRESHOLD;
    if (input.passRate >= threshold) {
      return { skipped: true as const, reason: "pass_rate_above_threshold" };
    }
    const profile = this.profiles.get(input.profileId);
    if (!profile) return { skipped: true as const, reason: "profile_not_found" };
    if (profile.governanceTier !== "L1" && profile.governanceTier !== "L0") {
      return { skipped: true as const, reason: "signal_only_for_l0_l1" };
    }
    const run = await this.createEvolutionRun({
      profileId: input.profileId,
      tenantId: input.tenantId,
      trigger: "signal",
      tier: profile.governanceTier,
      target: "mcp_description",
    });
    return run!;
  }

  async approveEvolutionRun(input: ApproveEvolutionInput): Promise<EvolutionRun | null> {
    const run = this.evolutionRuns.get(input.runId);
    if (!run || run.status !== "awaiting_review") return null;
    const profile = this.profiles.get(run.profileId);
    if (!profile) return null;
    const ws = this.workspaces.get(profile.workspaceId);
    if (!ws || ws.tenantId !== input.tenantId) return null;

    const baseVersion = this.profileVersions.get(run.baseVersionId);
    if (!baseVersion) return null;

    const candidateId =
      input.candidateVersionId ??
      run.candidateVersionId ??
      (crypto.randomUUID() as AgentProfileVersion["id"]);

    if (!this.profileVersions.has(candidateId)) {
      this.profileVersions.set(candidateId, {
        id: candidateId,
        profileId: profile.id,
        version: baseVersion.version + 1,
        snapshot: structuredClone(baseVersion.snapshot),
        createdAt: new Date(),
        approvalStatus: "approved",
      });
    }

    run.candidateVersionId = candidateId;
    run.status = "completed";
    await this.appendAudit({
      tenantId: input.tenantId,
      workspaceId: profile.workspaceId,
      action: "evolution.approved",
      actor: input.reviewer,
      metadata: { runId: run.id, candidateVersionId: candidateId },
    });
    return run;
  }

  async rejectEvolutionRun(input: RejectEvolutionInput): Promise<EvolutionRun | null> {
    const run = this.evolutionRuns.get(input.runId);
    if (!run || run.status !== "awaiting_review") return null;
    const profile = this.profiles.get(run.profileId);
    if (!profile) return null;
    const ws = this.workspaces.get(profile.workspaceId);
    if (!ws || ws.tenantId !== input.tenantId) return null;

    run.status = "rejected";
    await this.appendAudit({
      tenantId: input.tenantId,
      workspaceId: profile.workspaceId,
      action: "evolution.rejected",
      actor: input.reviewer,
      metadata: { runId: run.id, reason: input.reason },
    });
    return run;
  }

  async createApiKey(
    tenantId: Tenant["id"],
    name: string,
  ): Promise<{ key: string; record: ApiKeyRecord }> {
    const generated = generateApiKey(tenantId, name);
    this.apiKeys.set(generated.record.id, generated.record);
    return generated;
  }

  async listApiKeys(tenantId: Tenant["id"]): Promise<ApiKeyRecord[]> {
    return [...this.apiKeys.values()].filter((key) => key.tenantId === tenantId);
  }

  async listAllApiKeys(): Promise<ApiKeyRecord[]> {
    return [...this.apiKeys.values()];
  }

  async addWorkspaceMember(
    workspaceId: WorkspaceId,
    userId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMemberRecord> {
    const id = crypto.randomUUID();
    const member: WorkspaceMemberRecord = {
      id,
      workspaceId,
      userId,
      role,
      createdAt: new Date(),
    };
    this.workspaceMembers.set(`${workspaceId}:${userId}`, member);
    return member;
  }

  async getWorkspaceMember(
    workspaceId: WorkspaceId,
    userId: string,
  ): Promise<WorkspaceMemberRecord | null> {
    return this.workspaceMembers.get(`${workspaceId}:${userId}`) ?? null;
  }

  async setWorkspacePolicy(policy: AccessPolicy): Promise<AccessPolicy> {
    this.workspacePolicies.set(policy.workspaceId, policy);
    return policy;
  }

  async getWorkspacePolicy(workspaceId: WorkspaceId): Promise<AccessPolicy | null> {
    return this.workspacePolicies.get(workspaceId) ?? null;
  }

  async saveProfileEvalRun(
    run: Omit<ProfileEvalRun, "id" | "createdAt">,
  ): Promise<ProfileEvalRun> {
    const record: ProfileEvalRun = {
      ...run,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    this.profileEvalRuns.set(record.id, record);
    return record;
  }

  async listProfileEvalRuns(profileId: ProfileId, limit = 20): Promise<ProfileEvalRun[]> {
    return [...this.profileEvalRuns.values()]
      .filter((run) => run.profileId === profileId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async registerKbDocument(
    entry: Omit<KbDocumentRegistryEntry, "createdAt">,
  ): Promise<KbDocumentRegistryEntry> {
    const record: KbDocumentRegistryEntry = {
      ...entry,
      createdAt: new Date(),
    };
    this.kbDocumentRegistry.set(record.id, record);
    return record;
  }

  async listKbDocuments(profileId: ProfileId): Promise<KbDocumentRegistryEntry[]> {
    return [...this.kbDocumentRegistry.values()]
      .filter((doc) => doc.profileId === profileId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  protected checkRateLimit(tenantId: string, rpm: number): QuotaCheckResult {
    const now = Date.now();
    const windowMs = 60_000;
    let window = this.rateWindows.get(tenantId);
    if (!window || now - window.windowStart >= windowMs) {
      window = { count: 0, windowStart: now };
    }
    window.count += 1;
    this.rateWindows.set(tenantId, window);
    if (window.count > rpm) {
      return { allowed: false, reason: "rate_limit_exceeded" };
    }
    return { allowed: true };
  }

  protected getTokenUsage(tenantId: string) {
    const day = new Date().toISOString().slice(0, 10);
    const existing = this.tokenUsageByTenant.get(tenantId);
    if (!existing || existing.day !== day) {
      return { day, tokens: 0 };
    }
    return existing;
  }

  async close(): Promise<void> {
    return;
  }
}
