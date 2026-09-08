/**
 * Session Bootstrap — materialize ProfileBootstrapBundle and inject runtime policy.
 */
import type { ProfileBootstrapBundle, ProfileVersionId } from "@diy-agent/domain";
import { setWorkspacePolicy } from "@diy-agent/dsh-policy-plugin";
import { extractTenantContext, validateSessionMeta } from "@diy-agent/dsh-tenant-plugin";
import {
  setActiveBootstrapBundle,
  storeProfileBootstrapBundle,
} from "./bundle.js";
import {
  materializeProfileBootstrapBundle,
  type FetchLike,
  type MaterializeBootstrapInput,
} from "./materialize.js";

export const name = "@diy-agent/dsh-bootstrap-plugin";
export const inject = ["sessions"] as const;

export {
  assertMcpCatalogApproved,
  buildProfileBootstrapBundle,
  bundleCacheKey,
  deriveBlockedMcpServers,
  getActiveBootstrapBundle,
  getProfileBootstrapBundle,
  readKbConfigFromSnapshot,
  resetBootstrapCacheForTests,
  storeProfileBootstrapBundle,
} from "./bundle.js";
export {
  isDevDegradeEnabled,
  materializeProfileBootstrapBundle,
  type MaterializeBootstrapInput,
  type FetchLike,
} from "./materialize.js";

interface SessionsService {
  create: (
    id: string,
    opts?: { meta?: Record<string, string> },
  ) => unknown | Promise<unknown>;
}

interface PluginContext {
  sessions: SessionsService;
  effect: (fn: () => void | (() => void)) => void;
}

export interface BootstrapPluginConfig {
  controlPlaneUrl?: string;
  serviceAccountToken?: string;
  fetchImpl?: FetchLike;
}

export function applyBootstrapToRuntime(bundle: ProfileBootstrapBundle): void {
  setWorkspacePolicy(bundle.policy);
  storeProfileBootstrapBundle(bundle);
  setActiveBootstrapBundle(bundle);
}

export function apply(ctx: PluginContext, config: BootstrapPluginConfig = {}): void {
  const controlPlaneUrl =
    config.controlPlaneUrl ?? process.env.DIY_CONTROL_PLANE_URL ?? "http://127.0.0.1:9878";

  ctx.effect(() => {
    const originalCreate = ctx.sessions.create.bind(ctx.sessions);
    ctx.sessions.create = async (id, opts) => {
      const meta = opts?.meta ?? {};
      validateSessionMeta(meta);
      const sessionCtx = extractTenantContext(meta);
      const bundle = await materializeProfileBootstrapBundle({
        controlPlaneUrl,
        serviceAccountToken: config.serviceAccountToken ?? process.env.DIY_SERVICE_ACCOUNT_TOKEN,
        fetchImpl: config.fetchImpl,
        profileId: sessionCtx.profileId as ProfileBootstrapBundle["profileId"],
        profileVersionId: sessionCtx.profileVersionId as ProfileVersionId,
        workspaceId: sessionCtx.workspaceId as ProfileBootstrapBundle["workspaceId"],
        tenantId: sessionCtx.tenantId as ProfileBootstrapBundle["tenantId"],
      });
      applyBootstrapToRuntime(bundle);
      return originalCreate(id, opts);
    };
    return () => {
      ctx.sessions.create = originalCreate;
    };
  });
}
