import type {
  AgentProfile,
  AgentProfileVersion,
  EvolutionRun,
  GovernanceTier,
  Session,
  Tenant,
  TenantGateway,
  Workspace,
} from "@diy-agent/domain";

export interface CreateTenantInput {
  name: string;
  dbSchema?: string;
  isolationMode?: Tenant["isolationMode"];
  gateway?: Partial<TenantGateway>;
}

export interface CreateWorkspaceInput {
  tenantId: Tenant["id"];
  name?: string;
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

export interface ControlPlaneStore {
  createTenant(input: CreateTenantInput): Promise<Tenant>;
  getTenant(id: Tenant["id"]): Promise<Tenant | null>;
  updateTenantGateway(
    id: Tenant["id"],
    gateway: TenantGateway
  ): Promise<Tenant | null>;

  getProfile(id: ProfileId): Promise<AgentProfile | null>;

  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace | null>;
  createProfile(input: CreateProfileInput): Promise<{
    profile: AgentProfile;
    version: AgentProfileVersion;
  } | null>;
  createSession(input: CreateSessionInput): Promise<{
    session: Session;
    dshMeta: Record<string, string>;
  } | null>;

  createEvolutionRun(input: CreateEvolutionRunInput): Promise<EvolutionRun | null>;
  getEvolutionRun(id: string): Promise<EvolutionRun | null>;
  triggerEvolutionSignal(
    input: TriggerEvolutionSignalInput
  ): Promise<EvolutionRun | { skipped: true; reason: string }>;
}

type ProfileId = AgentProfile["id"];

export function defaultGateway(
  overrides?: Partial<TenantGateway>
): TenantGateway {
  return {
    allowedProviders: ["openai", "deepseek", "anthropic"],
    rateLimitRpm: 600,
    ...overrides,
  };
}
