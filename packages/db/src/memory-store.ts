import type {
  AgentProfile,
  AgentProfileVersion,
  EvolutionRun,
  Session,
  Tenant,
  Workspace,
} from "@diy-agent/domain";
import { DEFAULT_EVOLUTION_SIGNAL_THRESHOLD, resolveModelRoute } from "@diy-agent/domain";
import type {
  ControlPlaneStore,
  CreateEvolutionRunInput,
  CreateProfileInput,
  CreateSessionInput,
  CreateTenantInput,
  CreateWorkspaceInput,
  TriggerEvolutionSignalInput,
} from "./types.js";
import { defaultGateway } from "./types.js";

export class MemoryStore implements ControlPlaneStore {
  private tenants = new Map<string, Tenant>();
  private workspaces = new Map<string, Workspace>();
  private profiles = new Map<string, AgentProfile>();
  private profileVersions = new Map<string, AgentProfileVersion>();
  private sessions = new Map<string, Session>();
  private evolutionRuns = new Map<string, EvolutionRun>();

  async getProfile(id: AgentProfile["id"]): Promise<AgentProfile | null> {
    return this.profiles.get(id) ?? null;
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

  async updateTenantGateway(
    id: Tenant["id"],
    gateway: Tenant["gateway"]
  ): Promise<Tenant | null> {
    const tenant = this.tenants.get(id);
    if (!tenant) return null;
    tenant.gateway = gateway;
    return tenant;
  }

  async createWorkspace(
    input: CreateWorkspaceInput
  ): Promise<Workspace | null> {
    if (!this.tenants.has(input.tenantId)) return null;
    const id = crypto.randomUUID() as Workspace["id"];
    const ws: Workspace = {
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

    const profileId = crypto.randomUUID() as AgentProfile["id"];
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

    profile.pinnedVersionId = versionId;
    this.profiles.set(profileId, profile);
    this.profileVersions.set(versionId, version);
    return { profile, version };
  }

  async createSession(input: CreateSessionInput) {
    const profile = this.profiles.get(input.profileId);
    if (!profile?.pinnedVersionId) return null;
    const ws = this.workspaces.get(profile.workspaceId);
    if (!ws || ws.tenantId !== input.tenantId) return null;

    const sessionId = crypto.randomUUID() as Session["id"];
    const session: Session = {
      id: sessionId,
      workspaceId: profile.workspaceId,
      profileId: profile.id,
      profileVersionId: profile.pinnedVersionId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(sessionId, session);

    return {
      session,
      dshMeta: {
        "diy.tenantId": ws.tenantId,
        "diy.workspaceId": ws.id,
        "diy.profileId": profile.id,
        "diy.profileVersionId": profile.pinnedVersionId,
      },
    };
  }

  async createEvolutionRun(
    input: CreateEvolutionRunInput
  ): Promise<EvolutionRun | null> {
    const profile = this.profiles.get(input.profileId);
    if (!profile?.pinnedVersionId) return null;
    const ws = this.workspaces.get(profile.workspaceId);
    if (!ws || ws.tenantId !== input.tenantId) return null;

    const tier = input.tier ?? profile.governanceTier;
    if (tier === "L3") throw new Error("evolution_tier_forbidden");

    const run: EvolutionRun = {
      id: crypto.randomUUID(),
      profileId: profile.id,
      baseVersionId: profile.pinnedVersionId,
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
}
