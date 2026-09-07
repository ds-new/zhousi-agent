import {
  DEFAULT_EVOLUTION_SIGNAL_THRESHOLD,
  SESSION_TOKEN_TTL_MS,
  isTraceExpired,
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
  type SkillCatalogEntry,
  type Tenant,
  type TenantGateway,
  type WebhookRegistration,
} from "@diy-agent/domain";
import type {
  ControlPlaneStore,
  CreateEvolutionRunInput,
  CreateProfileInput,
  CreateSessionInput,
  CreateTenantInput,
  CreateWorkspaceInput,
  EvalTraceRecord,
  QuotaCheckResult,
  SessionCreateResult,
  TriggerEvolutionSignalInput,
} from "./types.js";
import { defaultGateway } from "./types.js";

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
  protected mcpCatalog = new Map<string, McpCatalogEntry>();
  protected credentialRefs = new Map<string, CredentialRefRecord>();
  protected auditLog: AuditEvent[] = [];
  protected quotaWarningsDispatched = new Set<string>();
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
    return [...this.skills.values()].filter(
      (s) =>
        s.tenantId === tenantId &&
        (workspaceId === undefined || s.workspaceId === undefined || s.workspaceId === workspaceId),
    );
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

    const run: EvolutionRun = {
      id: crypto.randomUUID(),
      profileId: profile.id,
      baseVersionId,
      tier,
      trigger: input.trigger,
      target: input.target ?? "skill",
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
    });
    return run!;
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
