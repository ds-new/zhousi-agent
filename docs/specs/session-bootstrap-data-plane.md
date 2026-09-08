# Spec: Session Bootstrap on Data Plane (Profile Snapshot → Runtime Enforcement)

**Status:** ready-for-agent  
**Source:** Architecture review (QwenPaw ToB #1) + Grilling Rounds 1–3  
**Domain glossary:** `CONTEXT.md`  
**Related ADRs:** `docs/adr/0001-kb-runtime-on-data-plane.md`, `docs/adr/0002-session-bootstrap-on-data-plane.md` (to be created at implementation start)

---

## Problem Statement

DIY Agent 在 Control Plane 已能返回 Profile 版本 snapshot、Workspace Access Policy、Credential Ref 列表与 MCP Catalog，但 Data Plane 的 DSH 插件在 Session 启动后并未自动注入这些配置。Access Policy 依赖手工调用 `setWorkspacePolicy`；Credential 解密与 MCP env 注入未接入 turn loop；MCP 注册 `pending` 状态在 runtime 不生效；`dsh-tenant-plugin` 异步 pull snapshot 且不携带 Service Account token，与受保护的 Profile version GET 冲突。结果是平台在 **Control Plane 治理 API 层** 具备 QwenPaw ToB 词汇，但在 **Data Plane turn 内 enforcement 层** 断裂，Agent 首 turn 可能在无 policy、无 MCP 审批、无 vault 注入的情况下运行。

## Solution

新建 **`dsh-bootstrap-plugin`** 作为 Session Bootstrap module：在 **Session create 时同步** 从 Control Plane 拉取 Profile 版本与 MCP Catalog，materialize 为 **`ProfileBootstrapBundle`** 写入共享 cache，并注入 Access Policy 到 policy-plugin；Enterprise 场景通过扩展 **`profile.pinned` webhook / profile-sync reconcile** payload 离线 materialize 同一 bundle；MCP pending 条目进入 blocklist 并在 pool acquire 与 policy tool gate 双重 enforce；Credential 保持 **lazy** 在 `tool/before-call` 由 vault-plugin 解密注入。分四个 Phase 交付，Phase 1 优先修复 policy 注入与 SA 鉴权。

---

## User Stories

### QwenPaw 治理闭环

1. As a Data Plane operator, I want Access Policy applied automatically when a Session starts, so that tool calls are governed from turn one without manual plugin setup.
2. As a Tenant Admin, I want MCP servers with `pending` approval status blocked at runtime, so that unapproved integrations cannot be invoked by agents.
3. As an Enterprise operator, I want pinned Profile snapshots to materialize a full bootstrap bundle offline, so that Sessions work when Control Plane is unreachable after sync.
4. As a Platform operator, I want bootstrap failures to fail-fast on Session create in production, so that agents never run with missing governance config.
5. As a developer, I want a single `ProfileBootstrapBundle` cache, so that KB, policy, and MCP plugins read consistent config without duplicate CP pulls.

### Session Bootstrap module

6. As a Data Plane runtime, I want Session create to synchronously await bootstrap before returning, so that the first turn has policy and MCP blocklist ready.
7. As a Workspace Builder, I want policy sourced from the Control Plane GET response `policy` field (not embedded in snapshot), so that workspace policy updates are authoritative at pull time without snapshot duplication.
8. As a Data Plane service account, I want bootstrap HTTP pulls to use `DIY_SERVICE_ACCOUNT_TOKEN`, so that Profile version and MCP catalog reads are authenticated consistently.
9. As a Tenant Admin, I want MCP catalog fetched as a separate authenticated GET, so that pending/approved status is available for runtime blocklist without overloading the version GET schema.
10. As an operator, I want `dsh-tenant-plugin` to only validate Session meta, so that pull/cache responsibilities are not duplicated across plugins.

### Credential & vault (Enterprise)

11. As an Enterprise Data Plane operator, I want credential refs resolved lazily on first MCP tool call, so that secrets are not preloaded for every Session.
12. As a Tenant Admin, I want vault decryption hooked on `tool/before-call` when bindings include env refs, so that plaintext never transits Control Plane.
13. As a Platform operator, I want vault bootstrap limited to Enterprise bundle overlay, so that Standard tenants without KMS are unaffected.

### Profile Sync & webhooks

14. As an Enterprise Data Plane, I want `profile.pinned` webhooks to include policy, credentialRefIds, and mcpCatalog, so that offline bundle materialization matches live bootstrap.
15. As an Enterprise Data Plane, I want reconcile (`GET /tenants/{id}/profile-sync`) entries to carry the same bootstrap fields, so that periodic sync refreshes offline cache completely.
16. As a Workspace Builder, I want Sessions bound to a pinned Profile version to use bundle policy frozen at Session create, so that mid-session workspace policy edits do not silently change in-flight Sessions.

### KB integration

17. As a Data Plane runtime, I want `dsh-kb-plugin` to read `kbConfig` from `ProfileBootstrapBundle`, so that KB snapshot resolution shares the same cache as governance bootstrap.
18. As a developer, I want deprecated dual-cache logic in KB resolver removed after bundle migration, so that Enterprise and Standard paths stay unified.

### MCP enforcement

19. As a Data Plane runtime, I want `assertMcpCatalogApproved(serverName, bundle)` invoked from MCP pool acquire and policy tool gate, so that pending servers are blocked at connection and tool layers.
20. As a Tenant Admin, I want approved MCP servers to proceed through existing warm pool semantics, so that performance characteristics are unchanged for vetted integrations.

### Dev & ops

21. As a developer, I want `DIY_BOOTSTRAP_DEV_DEGRADE=true` to fall back to default workspace policy in non-production only, so that local debugging is possible without weakening prod fail-fast.
22. As a Platform architect, I want ADR-0002 documenting bootstrap responsibility migration from tenant-plugin, so that future reviews do not re-suggest split caches.
23. As a Tenant Admin, I want MCP catalog GET protected by service account auth, so that transport URLs and connection templates are not anonymously readable.

### Plugin bundle ordering

24. As a DSH operator, I want `cordis.patch.yml` ordered tenant → bootstrap → policy → mcp-pool → kb, so that Session create wrapping and injection occur before enforcement plugins register handlers.

---

## Implementation Decisions

### Grilling consensus (Rounds 1–3)

| Topic | Decision |
|-------|----------|
| Deepen target | Profile Snapshot → Data Plane Bootstrap (#1 QwenPaw review) |
| Module | New `dsh-bootstrap-plugin`; tenant-plugin slimmed to meta validation only |
| Trigger | Synchronous on `sessions/create`; Enterprise offline fail-fast on cache miss |
| Policy source | GET `/profiles/{id}/versions/{vid}` response **`policy` field** |
| Credential refs | Lazy decrypt on `tool/before-call` (Enterprise vault-plugin) |
| Cache | Single **`ProfileBootstrapBundle`**; KB/policy/MCP read bundle |
| CP pulls | Two legs: version GET + `GET /mcp/catalog?tenantId=`; both SA-authenticated |
| MCP pending | `blockedMcpServers` derived from catalog; enforce in pool + policy |
| Bundle on pin | Webhook + reconcile include policy, credentialRefIds, mcpCatalog |
| Session policy refresh | No mid-session refresh (pinned version semantics) |
| Dev degrade | `DIY_BOOTSTRAP_DEV_DEGRADE=true` non-prod only |
| ADR | ADR-0002 + CONTEXT **Session Bootstrap** at Phase 1 start |

### ProfileBootstrapBundle (canonical type)

From grilling prototype:

```
ProfileBootstrapBundle {
  profileId: ProfileId
  profileVersionId: ProfileVersionId
  workspaceId: WorkspaceId
  tenantId: TenantId
  snapshot: Record<string, unknown>
  policy: AccessPolicy
  credentialRefIds: string[]
  mcpCatalog: McpCatalogEntry[]
  blockedMcpServers: Set<string>   // derived: approvalStatus !== 'approved'
  kbConfig?: KnowledgeBaseConfig   // parsed from snapshot
  pinnedAt?: Date
}
```

`ProfileSyncEntry` becomes bundle-compatible (same fields or alias) for Enterprise cache writes.

### Bootstrap module interface

Export from bootstrap plugin:

```
materializeProfileBootstrapBundle(input: {
  controlPlaneUrl: string
  serviceAccountToken?: string
  profileId, profileVersionId, workspaceId, tenantId
  fetchImpl?: FetchLike
}): Promise<ProfileBootstrapBundle>

applyBootstrapToRuntime(bundle: ProfileBootstrapBundle): void
  // setWorkspacePolicy(bundle.policy)
  // store bundle in shared cache keyed profileId:versionId

assertMcpCatalogApproved(serverName: string, bundle: ProfileBootstrapBundle): void

getProfileBootstrapBundle(profileId, versionId): ProfileBootstrapBundle | null
```

`apply()` wraps `sessions.create`: validate meta (tenant) → await materialize → apply → fail-fast or throw `bootstrap_unavailable`.

### Control Plane contract changes

**GET `/profiles/{id}/versions/{vid}`** — unchanged shape; bootstrap must read `policy` and `credentialRefIds` (already returned).

**GET `/mcp/catalog?tenantId=`** — add **Service Account auth** (align with version GET).

**POST pin / webhook `profile.pinned` payload** — extend with:

```
{
  profileId, versionId, snapshot, pinnedAt,
  policy: AccessPolicy,
  credentialRefIds: string[],
  mcpCatalog: McpCatalogEntry[]
}
```

**GET `/tenants/{id}/profile-sync`** — entries include same extended fields for reconcile materialization.

### Plugin changes

| Plugin | Change |
|--------|--------|
| dsh-tenant-plugin | Remove pull/cache; keep meta validation + extractTenantContext |
| dsh-bootstrap-plugin | New; sessions inject; materialize + cache + wrap create |
| dsh-policy-plugin | Read bundle optional; primary inject via bootstrap `setWorkspacePolicy` |
| dsh-mcp-pool-plugin | Call `assertMcpCatalogApproved` in acquire |
| dsh-vault-plugin | Enterprise: `tool/before-call` lazy `injectMcpEnv` |
| dsh-kb-plugin | `getKbConfigFromBundle()` replaces dual-cache resolver |
| dsh-profile-sync-plugin | Webhook/reconcile handlers call `materializeProfileBootstrapBundle` from payload |

**cordis.patch.yml** insert order: tenant → **bootstrap** → policy → mcp-pool → trace → kb (bootstrap after tenant).

**cordis.enterprise.patch.yml** — vault remains overlay; bootstrap works with vault lazy hook.

### Delivery phases

| Phase | Deliverable |
|-------|-------------|
| **1** | bootstrap plugin; SA auth on catalog GET; sync Session create materialize; policy inject; tenant slim; ADR-0002 + CONTEXT |
| **2** | MCP blocklist + pool/policy enforce; catalog in bundle |
| **3** | Webhook/reconcile extended payload; profile-sync materialize; vault lazy inject |
| **4** | KB bundle migration; remove old KB dual-cache resolver |

### Failure modes

| Condition | Production | Dev (`DIY_BOOTSTRAP_DEV_DEGRADE=true`) |
|-----------|------------|----------------------------------------|
| CP pull 401/5xx | Session create fails `bootstrap_unavailable` | Optional default policy + warn log |
| Missing snapshot | fail-fast | degrade if flag set |
| Enterprise offline cache miss | fail-fast (existing gate) | unchanged |

---

## Testing Decisions

### What makes a good test

Assert **observable bootstrap outcomes** at module interfaces: bundle fields after mock CP fetch, policy injected into policy-plugin evaluation, MCP pending blocked on acquire, Session create throws on pull failure — not plugin registration order or private fetch URLs.

### Recommended test seams

| Priority | Seam | Proves | Prior art |
|----------|------|--------|-----------|
| **Primary** | **`dsh-bootstrap-plugin` unit** | materialize from mock version+catalog responses; inject policy; fail-fast | `dsh-kb-plugin/test`, `dsh-policy-plugin/test` |
| **Secondary** | **profile-sync webhook materialize** | offline bundle fields match live bootstrap | `dsh-profile-sync-plugin/test` |
| **Tertiary** | **Control Plane webhook payload** | pin fires extended `profile.pinned` shape | `sprint-3.test.ts` |

Regression: maintain **73/73** passing; add tests per phase without breaking existing CP integration tests.

**Ideal convergence:** bootstrap plugin unit seam covers 80% behavior; one CP test validates webhook payload extension.

---

## Out of Scope

- Mid-session Access Policy hot reload (requires separate ADR)
- Policy `ask` → DSH user-approval flow (separate deepen #3 from QwenPaw review)
- File Guard / Sandbox / Skill Scanner
- Merging version GET + catalog GET into single CP endpoint (optional future optimization)
- Replacing `dsh-tenant-plugin` entirely (meta validation stays)
- Production degrade-on-failure (fail-fast only in prod)
- Skill body Data Plane storage (separate candidate #6)
- Full DSH turn loop in `services/data-plane` HTTP process (separate candidate #4)

---

## Further Notes

### CONTEXT.md glossary (Phase 1)

**Session Bootstrap**: The Data Plane action that materializes a `ProfileBootstrapBundle` from Control Plane (or Enterprise profile-sync cache) at Session create and injects Access Policy, MCP blocklist, and KB config into runtime plugins before the first turn.

### ADR-0002 outline

Record: bootstrap replaces tenant-plugin pull; dual CP fetch; fail-fast; bundle single cache; relationship to ADR-0001 (KB reads bundle); Enterprise webhook extension.

### Issue tracker

**Label:** `ready-for-agent`

```bash
gh issue create --repo ds-new/zhousi-agent \
  --title "Spec: Session Bootstrap on Data Plane (QwenPaw runtime enforcement)" \
  --label "ready-for-agent" \
  --body-file docs/specs/session-bootstrap-data-plane.md
```

### Grilling frontier

All Round 1–3 decisions locked; ready for `/implement` Phase 1 after ADR-0002 + CONTEXT update.
