# Spec: ToB Multi-Tenant Self-Evolving Agent Platform

**Status:** ready-for-agent  
**Source:** Grilling Rounds 1–4 + existing prototype skeleton  
**Domain glossary:** `CONTEXT.md`

---

## Problem Statement

企业客户需要一套可私有化部署、支持多租户隔离的 ToB 智能体平台，具备：Session/Memory 隔离、可自定义 Skill 与 MCP、快速 MCP 连接、知识库接入、模型可配置、轻量级 Agent 运行时、Profile 级与多 Agent 级评估，以及基于执行反馈的持续自进化能力。现有开源方案（QwenPaw、Hermes、Pi、DeepSeek Harness）各擅所长但无法单独满足 ToB 多租户 + DB 隔离 + 混合部署 + 分级治理的完整需求。

## Solution

构建 **DIY Agent Platform**：以 DeepSeek Harness（DSH）为 Data Plane 运行时基座，托管 **Control Plane** 管理 Tenant/Workspace/Agent Profile 版本、评估与 Evolution 编排；Memory、KB、凭证与对话内容留在客户域 Data Plane。平台融合 QwenPaw 的治理与 MCP 驱动、Hermes 的 GEPA 自进化、Pi 的轻量 Agent loop 设计哲学，提供 Tenant 级 Skill/MCP Catalog、 sensitivity 驱动的 MCP 热连接池、L0–L3 分级治理，以及 Golden Task + Profile Pin Gate 评估体系。

---

## User Stories

### 租户与平台管理

1. As a Platform Admin, I want to create a Tenant with an isolated database boundary, so that enterprise customers' data never commingles.
2. As a Platform Admin, I want to assign `isolationMode` of `schema` or `dedicated` per Tenant tier, so that compliance requirements can be met without over-provisioning small customers.
3. As a Tenant Admin, I want to configure a Tenant Gateway with allowed model providers, rate limits, and daily token caps, so that model usage stays within contract and budget.
4. As a Tenant Admin, I want disallowed model providers to be hard-rejected at Profile creation, so that shadow IT model usage is prevented.
5. As a Tenant Admin, I want to receive webhook alerts at 80% of daily token quota, so that I can act before hard limits block new Sessions.
6. As a Tenant Admin, I want new Sessions to be rejected when daily token quota is exhausted, so that cost overruns are bounded while in-flight Sessions can finish their current turn.

### Workspace 与 Session

7. As a Tenant Admin, I want to create Workspaces within my Tenant, so that teams or projects have isolated Session and Memory namespaces.
8. As a Workspace Builder, I want every Session to be bound to a fixed Agent Profile version at creation, so that conversation behavior is reproducible and auditable.
9. As an End User, I want a Session-scoped token with workspace scope and 24h TTL, so that I can chat securely without Tenant Admin privileges.
10. As a Data Plane operator, I want DSH Sessions to require tenant/workspace/profile/version meta, so that orphan sessions without Control Plane provisioning are rejected.
11. As a Tenant Admin, I want existing Sessions to continue using their pinned Profile version after a new version is published, so that in-flight work is not disrupted.

### Agent Profile 与版本

12. As a Workspace Builder, I want to create an Agent Profile with system prompt, model route, skills, MCP bindings, and optional orchestration config, so that I can define a purpose-built agent.
13. As a Workspace Builder, I want to declare a primary model with an optional fallback chain within the Tenant Gateway allowlist, so that transient provider failures are handled without violating policy.
14. As a Workspace Builder, I want model fallback to trigger only on provider 5xx/timeout—not on quota exhaustion—so that silent degradation on billing limits never occurs.
15. As a Workspace Builder, I want every Profile change to produce an immutable Agent Profile version snapshot, so that evolution and rollback are traceable.
16. As a Tenant Admin, I want to pin an approved Profile version for production use, so that only vetted configurations serve End Users.
17. As a Data Plane runtime, I want to pull the pinned Profile snapshot from Control Plane on Session create, so that execution config is authoritative and up to date.
18. As an Enterprise customer, I want Profile pin events to push via webhook and periodic reconcile to my VPC Data Plane, so that offline-capable deployments stay synchronized.
19. As an Enterprise Data Plane, I want to refuse new Session creation when Control Plane is unreachable and no cached snapshot exists, so that stale or missing config never silently runs.

### Skill Catalog

20. As a Tenant Admin, I want to register Skills in a Tenant Skill Catalog with metadata stored in Control Plane and SKILL.md body on Data Plane disk, so that skill content stays in the customer data domain.
21. As a Workspace Builder, I want to create Workspace-private Skill overrides, so that team-specific procedures do not pollute the Tenant catalog.
22. As a Workspace Builder, I want Agent Profiles to reference Skills by ID, so that skill updates can be managed centrally without duplicating prompt text in every Profile.
23. As a Tenant Admin, I want L1 evolution to mutate Workspace-private Skills only—not shared Tenant Skills—so that automated improvement cannot break other teams.

### MCP Catalog 与连接池

24. As a Tenant Admin, I want to register MCP Servers in a Tenant MCP Catalog with connection templates, so that Profiles do not duplicate transport and credential configuration.
25. As a Workspace Builder, I want Profile MCP bindings to reference catalog entries with optional sensitivity and poolScope overrides, so that I can tune isolation per use case.
26. As a Tenant Admin, I want newly registered MCP Servers to require L2 human approval before first use, so that untrusted integrations are gated.
27. As a Data Plane runtime, I want MCP pool scope to be chosen automatically from sensitivity—readonly→tenant, normal→workspace, high→session—so that connection reuse balances speed and isolation.
28. As a Data Plane runtime, I want warm MCP connections for readonly and normal sensitivity with configurable idle timeout, so that repeated tool calls start quickly.
29. As a Tenant Admin, I want a cap on warm MCP connections per Tenant (default 10), so that resource exhaustion from connection pooling is prevented.
30. As a Workspace Builder, I want high-sensitivity MCP bindings to never use warm pools, so that write-capable tools do not leak state across Sessions.

### 凭证与安全

31. As a Tenant Admin, I want to register Credential Refs in Control Plane without storing secret plaintext, so that SaaS control plane never holds customer secrets.
32. As a Data Plane operator, I want secrets resolved locally from an encrypted tenant vault and injected into MCP environments, so that credentials never traverse the Control Plane API.
33. As a Tenant Admin, I want credential and vault mutations to be L3 (never auto-evolved), so that autonomous agents cannot exfiltrate or rotate secrets without human action.
34. As a Tenant Admin, I want Access Policy rules with allow/deny/ask effects at MCP tool granularity, so that agent capabilities match enterprise security posture.
35. As a Tenant Admin, I want default deny-by-default for high-sensitivity write MCP tools, so that agents cannot mutate production systems without explicit policy.
36. As an End User, I want ask-effect tool calls to pause for approval via DSH user-approval flow, so that risky actions require explicit consent.
37. As a Tenant Admin, I want ask/allow/deny decisions written to an audit log, so that compliance reviews can reconstruct policy enforcement.

### Memory 自治理

38. As a Workspace Builder, I want Memory entries classified as fact, preference, procedure, or episodic, so that retrieval and governance can treat types differently.
39. As a Data Plane runtime, I want L0 automatic memory governance after each turn—TTL expiry, same-kind dedup at ≥0.92 similarity, episodic compaction—so that memory stays bounded without human curation.
40. As a Workspace Builder, I want episodic memories compacted into procedure summaries when count exceeds threshold (default 50), with originals soft-deleted and 30-day archive TTL, so that long-running workspaces do not grow unbounded.
41. As a Tenant Admin, I want memory governance failures to retry 3 times then alert, so that silent memory corruption does not accumulate.

### 知识库

42. As a Workspace Builder, I want to ingest documents into an internal Workspace KB with vector search, so that agents can answer from enterprise documents (Sprint 2a).
43. As a Workspace Builder, I want to connect external KB MCP servers as a federated search leg, so that existing enterprise search infrastructure is reused (Sprint 2b).
44. As an End User, I want hybrid KB search to fuse internal and external results via reciprocal rank fusion with configurable weights, so that answers draw from the best available sources.
45. As a Tenant Admin, I want KB document content to remain in Data Plane / tenant schema, so that document bodies are not copied to Control Plane.

### 评估与 Pin Gate

46. As a Workspace Builder, I want to define at least five Golden Tasks per Agent Profile, so that quality can be measured against representative scenarios.
47. As a Workspace Builder, I want to run Profile evaluation against Golden Tasks and receive pass rate, P95 latency, and tool success metrics, so that I know if a version is production-ready.
48. As a Tenant Admin, I want Profile Pin Gate defaults of passRate ≥ 0.85, P95 ≤ 8000ms, and toolSuccessRate ≥ 0.90, so that baseline quality is consistent across tenants.
49. As a Tenant Admin, I want pin to be blocked when Pin Gate fails, so that regressions cannot reach End Users.
50. As a Data Plane runtime, I want to POST Eval Traces to Control Plane after each turn, so that evaluation and evolution have execution evidence.
51. As a Tenant Admin, I want Eval Traces retained for 90 days, so that recent debugging and evolution have data while storage stays bounded.
52. As a Workspace Builder, I want Golden Task eval results retained permanently, so that longitudinal quality trends are available.

### 自进化

53. As a Workspace Builder, I want Evolution Runs triggered manually, by eval signal (passRate < 0.75), or on schedule, so that improvement can be proactive or reactive.
54. As a Data Plane runtime, I want failed/low-score traces fed to the Evolution Service, so that GEPA mutations target real failure modes—not random prompt drift.
55. As an Evolution operator, I want L1 evolution to auto-apply Skill and MCP description mutations with audit trail, so that low-risk improvements ship quickly.
56. As a Tenant Admin, I want L2 evolution (system prompt, new Skills, MCP registration, orchestration topology) to enter awaiting_review status, so that high-impact changes require explicit approval.
57. As a Tenant Admin, I want to approve or reject candidate Profile versions from Evolution Runs, so that human governance gates production impact.
58. As a platform operator, I want Evolution Service failures to return failed status—not mock success—so that operators never believe a mutation succeeded when GEPA was unavailable.

### 多 Agent 协作（Phase 2）

59. As a Workspace Builder, I want to configure orchestration topology as supervisor, pipeline, or blackboard with worker Profile IDs, so that multi-agent workflows match task structure.
60. As a Workspace Builder, I want multi-agent runs to emit handoff and collaboration metrics, so that team workflows can be observed even before Pin Gate enforcement.
61. As a Tenant Admin, I want multi-agent metrics excluded from MVP Pin Gate blocking, so that Phase 2 collaboration features can iterate without blocking MVP delivery.

### 集成与运维

62. As a Tenant Admin, I want a REST API with OpenAPI spec for all Control Plane operations, so that my systems can integrate programmatically.
63. As a Tenant Admin, I want webhooks for profile.pinned, evolution.awaiting_review, and eval.pin_gate_failed, so that my ITSM or CI/CD can react to platform events.
64. As a Tenant Admin, I want structured audit events for profile pin, evolution approval, MCP registration, policy decisions, vault rotation, and session creation—without conversation content—so that compliance audits are supported.
65. As a developer, I want docker-compose to start Postgres, Control Plane, Evolution sidecar, and DSH Data Plane with Standard plugin bundle, so that I can evaluate the platform locally in one command.
66. As an Enterprise operator, I want Helm charts separating Control Plane and Data Plane for customer VPC deployment, so that production topology matches the hybrid C-tier model.
67. As a Data Plane service account, I want mTLS authentication to Control Plane for profile pull and trace upload, so that inter-service traffic is mutually authenticated.
68. As a Tenant Admin, I want API key authentication for admin operations and optional OIDC SSO in Phase 2, so that MVP integration is simple while enterprise IdP integration is planned.

---

## Implementation Decisions

### Architecture layers

Four layers: **Control Plane** (SaaS CRUD, eval orchestration, evolution scheduling, audit, webhooks), **Data Plane** (DSH + diy plugins: tenant context, memory governance, MCP pool, policy gate, trace collector), **Evolution Service** (Python GEPA sidecar via DSPy), **Storage** (platform schema + per-tenant schema with workspace_id columns; dedicated DB for Enterprise tier).

Hybrid deployment tier **C**: Standard tenants use shared hosted Data Plane with logical isolation (tenant plugin meta + schema isolation); Enterprise tenants deploy Data Plane to customer VPC with profile sync webhook + 5-minute reconcile.

### Domain model

Hierarchy: **Tenant → Workspace → Agent Profile → Session**. Memory and KB are Workspace-scoped. Agent Profile versions are immutable; Session binds `profileVersionId` at create. Governance tiers L0–L3 govern automation boundaries for memory, skills, prompts, MCP, credentials, and orchestration.

Prototype type shapes (from existing domain module):

```
GovernanceTier = "L0" | "L1" | "L2" | "L3"
IsolationMode = "schema" | "dedicated"
McpPoolScope = "tenant" | "workspace" | "session"

resolveMcpPoolScope(binding):
  explicit poolScope wins
  else sensitivity "high" → session
  else sensitivity "readonly" → tenant
  else → workspace
```

Pin Gate defaults to align with grilling (note: prototype constants differ and must be updated):

```
ProfilePinGate:
  minPassRate: 0.85
  maxP95LatencyMs: 8000
  minToolSuccessRate: 0.90
```

Evolution signal threshold: `passRate < 0.75` or 3 consecutive negative user signals → L1 Evolution Run.

### Control Plane modules

- **Tenant/Workspace/Profile store**: Postgres platform schema + tenant schema template; MemoryStore for dev/tests.
- **Session factory**: Creates Session + DSH meta (`diy.tenantId`, `diy.workspaceId`, `diy.profileId`, `diy.profileVersionId`); issues End User session token.
- **Skill/MCP Catalog APIs**: CRUD metadata; content hash; approval status for new MCP (L2 pending until Tenant Admin approves).
- **Profile version API**: `GET /profiles/{id}/versions/{vid}` returns snapshot + policy + credentialRefIds (no plaintext).
- **Pin + eval APIs**: Golden task CRUD; `POST /profiles/{id}/eval/run`; `POST /profiles/{id}/pin` gated by Pin Gate.
- **Trace ingestion**: `POST /traces` with 90-day TTL.
- **Evolution orchestration**: Delegates to Evolution Service; persists Evolution Run state; approve/reject endpoints for L2.
- **Webhook dispatcher**: Registered tenant endpoints; events: `profile.pinned`, `evolution.awaiting_review`, `eval.pin_gate_failed`.
- **Quota enforcement**: Session create checks rateLimitRpm; trace upload accumulates maxTokensPerDay; 80% webhook warning.

### Data Plane DSH plugin bundle

**Standard (MVP):**

| Plugin | Responsibility |
|--------|----------------|
| dsh-tenant-plugin | Session meta validation; tenant context extraction |
| dsh-memory-plugin | L0 TTL → dedup → compaction pipeline (async after turn) |
| dsh-mcp-pool-plugin | Warm pool; sensitivity→scope; idle timeout 300s |
| dsh-policy-plugin | Access Policy beforeToolCall gate; ask → user-approval |
| dsh-trace-plugin | POST Eval Trace to Control Plane after turn |

**Enterprise add-ons:** dsh-vault-plugin, dsh-orchestrator-plugin, dsh-profile-sync-plugin.

Orchestration MVP remains Control Plane HTTP `/orchestration/run`; in-DSH spawn deferred to Phase 2.

### Profile Sync

Standard: pull snapshot on Session create; cache keyed by `(profileId, versionId)` with no TTL (versions immutable). Enterprise: add webhook on pin + 5-minute reconcile; offline refuses new Sessions without cache.

### Credential vault

Hybrid ref model: Control Plane stores CredentialRef metadata; Data Plane stores encrypted `vault.enc` per tenant (AES-256-GCM, key from customer KMS). MCP startup resolves refs locally. L3: no automated mutation.

### Access Policy

Tenant default deny-by-default for high write MCP; Workspace whitelist overrides; readonly MCP allow; ask for first high tool use (configurable). Policy JSON stored Control Plane; evaluated Data Plane `beforeToolCall`. MVP: MCP tool-level only (not full File Guard stack).

### Evolution Service API

```
POST /evolution/run
  Request: profileId, baseVersionId, tier, target, snapshot, evalTasks[], traces[]
  Response: runId, status, candidateVersionId, mutations[], evalScoreDelta, requiresReview

POST /evolution/runs/{id}/approve | /reject   (L2 only)
```

Engine: Python sidecar with GEPA for `target ∈ {skill, mcp_description}` at L1; `target=prompt` defaults L2. Remove mock fallback on Evolution client failure—return `failed`.

### Knowledge Base (phased)

Sprint 2a: internal pgvector ingest/search per Workspace in tenant schema. Sprint 2b: external MCP KB connector via MCP pool. Fusion: RRF with default weights internal 0.6 / external 0.4 (tenant-configurable).

### Auth

MVP: Tenant Admin API key (`diy_sk_*`); End User session token (workspace-scoped, 24h); Data Plane→Control Plane mTLS service account. Phase 2: Tenant Admin OIDC SSO; Workspace RBAC (admin/builder/user).

### Observability

MVP audit log in tenant schema: profile.pinned, evolution.approved/rejected, mcp.registered, policy.ask_resolved, vault.credential_rotated, session.created (no message content). Conversation content never leaves Data Plane. Enterprise: append-only audit + cold archive.

### Delivery

MVP: docker-compose (Postgres, control-plane :9878, evolution :9880, dsh-data-plane :3080). Production/Enterprise: Helm charts split by plane. Dev: npm workspace scripts preserved.

### Repository gap remediation

Current repo contains compiled prototype artifacts without TypeScript sources, migrations, or tests referenced by package scripts. Implementation must restore source packages, SQL migrations, Evolution Python service, docker-compose, OpenAPI spec, and remaining DSH plugins (policy, trace, vault, profile-sync) before feature work proceeds.

---

## Testing Decisions

### What makes a good test

Test **external behavior at the highest seam possible**—HTTP request/response contracts, store interface outcomes, and pure domain functions—without asserting internal plugin wiring or private method calls. Prefer black-box Control Plane integration tests over unit-testing DSH hook registration order.

### Primary test seam (recommended)

**Single seam: Control Plane HTTP API backed by in-memory store**, with Evolution Service and Data Plane interactions mocked at HTTP boundaries. This one seam validates Tenant→Workspace→Profile→Session lifecycle, gateway enforcement, pin gate, evolution orchestration, trace ingestion, and quota pre-checks—the core MVP user journeys—without requiring a live DSH process.

Rationale: matches existing prototype direction (testable server factory + MemoryStore); avoids multiplying seams across each DSH plugin until Standard bundle stabilizes.

Secondary seams (add only when primary seam insufficient):

- **Domain pure functions seam**: `resolveMcpPoolScope`, `resolveModelRoute`, Pin Gate scoring, memory governance pipeline stages—fast, no I/O.
- **Evolution Service contract seam**: HTTP mock verifying request/response schema and failed-status behavior (no mock success fallback).
- **Postgres store seam**: schema creation and tenant isolation integration test with testcontainers or ephemeral Postgres—one test proving platform + tenant schema bootstrap.

### Modules under test

| Module | Seam | Prior art |
|--------|------|-----------|
| Control Plane HTTP | Primary integration | Prototype `createControlPlaneServer` factory pattern |
| Domain helpers | Pure unit | Prototype `resolveMcpPoolScope` / gateway tests (to be restored) |
| Eval harness | Pure unit | Prototype `evaluatePinGate`, `scoreProfileTask` |
| Memory governance | Pure/async unit | Prototype `runGovernancePipeline` |
| MCP pool | Pure unit | Prototype `poolKey`, `resolveMcpPoolScope` interaction |
| Postgres store | Integration (secondary) | Prototype `PostgresStore.createTenant` schema bootstrap |
| Evolution client | HTTP contract | Replace stub fallback test with failure-path assertion |

DSH plugins: defer direct tests to Phase 2; validate indirectly via trace upload and policy audit events through Control Plane primary seam.

---

## Out of Scope

- Platform Marketplace for public Skills (Phase 3)
- Admin Console UI (Phase 2; MVP is REST + OpenAPI + optional CLI)
- Multi-agent Pin Gate blocking (Phase 2; metrics only in MVP)
- Full QwenPaw-style File Guard / Sandbox / Skill Scanner stack (rely on DSH native sandbox for MVP)
- GPU training or fine-tuning models
- Conversation content storage or analytics in Control Plane
- Tenant SSO / Workspace RBAC (Phase 2)
- Helm charts (Phase 2 / Enterprise; MVP is docker-compose only)
- Mock Evolution success fallback (explicitly removed)
- Source-less dist-only delivery state (must be remediated, not shipped as-is)

---

## Further Notes

### MVP milestones

| Sprint | Deliverable |
|--------|-------------|
| **0** | Restore TS sources, migrations, tests; docker-compose skeleton; OpenAPI draft |
| **1** | Tenant/Workspace/Profile/Session API; DSH Standard 5-plugin bundle; Profile pull sync; Pin Gate + Golden tasks |
| **2a** | Internal KB pgvector; trace ingestion; Evolution GEPA sidecar (L1 skill/mcp_description) |
| **2b** | External MCP KB; RRF fusion; webhooks; audit log |
| **3** | Enterprise: vault plugin, profile-sync webhook, Helm split, dedicated isolation mode |

### ADR candidates (hard-to-reverse)

1. **Tenant DB isolation via schema-per-tenant on shared Postgres** (Enterprise dedicated as opt-up)
2. **Hybrid credential vault: Control Plane refs only, Data Plane plaintext**
3. **GEPA Evolution as separate Python sidecar with L2 human approve gate**

### Issue tracker

Label: `ready-for-agent`. Publish this spec as a GitHub issue when `gh` CLI is available against `ds-new/zhousi-agent`.
