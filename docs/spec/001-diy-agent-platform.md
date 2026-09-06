# Spec: DIY Agent Platform — ToB 多租户自进化智能体

**Status:** ready-for-agent  
**Triage:** ready-for-agent  
**Created:** 2026-09-06

---

## Problem Statement

ToB 客户需要在自有数据域内部署可定制、可评估、可持续改进的 AI 智能体，同时满足严格的多租户隔离要求：不同企业的 Session、Memory、凭证与知识库不可串扰；不同团队（Workspace）在同一企业内也应有独立命名空间。

现有开源方案各擅胜场但无法直接组合：QwenPaw 提供 ToB 治理与 Hub 隔离思路，Hermes 提供 GEPA 自进化，Pi 提供轻量 agent loop，DeepSeek Harness 提供插件化运行时——但缺少统一的 Tenant/Workspace 数据模型、Profile 级评估门禁，以及 Memory 自治理与 MCP 热连接的企业级策略。

企业客户还需要：自定义 Skill/MCP、连接私有知识库、按 Profile 配置模型路由，并在不重新训练模型的前提下，通过 Evolution Run 迭代 Skill 与 Prompt。

## Solution

构建 **DIY Agent Platform**：混合架构的智能体平台。

- **Control Plane（可 SaaS 化）**：管理 Tenant、Workspace、Agent Profile 版本、Tenant Gateway、Evolution 调度与评估编排。
- **Data Plane（客户域）**：基于 DeepSeek Harness + Cordis 插件运行 Agent；Session/Memory/KB/MCP 沙箱均在租户边界内执行。
- **Evolution Service（Python 侧车）**：Hermes 式 GEPA/DSPy 进化，与主 Agent loop 解耦；L0–L3 Governance Tier 控制自动/人审/禁止变更。

平台吸收 QwenPaw（治理/Access Policy 参考）、Pi（轻量 loop 参考）、Hermes（GEPA 进化）、DSH（插件运行时）的优点，形成可版本化、可评估、可自进化的 ToB 智能体栈。

## User Stories

1. As a **Tenant admin**, I want to register my organization as a Tenant with an isolated database boundary, so that our data never commingles with other customers.
2. As a **Tenant admin**, I want to choose schema-per-tenant or dedicated-instance isolation, so that we can meet compliance requirements as we grow.
3. As a **Tenant admin**, I want to configure a Tenant Gateway with allowed model providers and rate limits, so that Profiles cannot route to unauthorized LLM endpoints.
4. As a **Tenant admin**, I want to create Workspaces for teams or projects, so that Sessions and Memory are namespaced within our organization.
5. As a **Tenant admin**, I want to manage MCP credentials in a tenant-scoped vault, so that secrets never leak across Workspaces inappropriately.
6. As an **Agent builder**, I want to create an Agent Profile with system prompt, model route, Skills, and MCP bindings, so that I can deploy a purpose-built assistant.
7. As an **Agent builder**, I want Agent Profile versions to be pin-able after passing evaluation, so that production behavior is predictable and auditable.
8. As an **Agent builder**, I want to override model and thinking level within Tenant Gateway constraints, so that each Profile can use the best model for its task.
9. As an **Agent builder**, I want to attach marketplace Skills and private Skills, so that I can extend agents without forking the platform.
10. As an **Agent builder**, I want to register custom MCP servers on a Profile, so that agents can call our internal systems.
11. As an **Agent builder**, I want MCP connections to warm-start at Workspace scope by default, so that tool latency stays low across turns.
12. As an **Agent builder**, I want high-sensitivity MCP tools to use Session-scoped pools, so that credentials and state do not leak between concurrent users.
13. As an **Agent builder**, I want read-only KB MCP connectors to share at Tenant scope, so that duplicate vector indexes are avoided.
14. As an **end user**, I want each Session confined to one Workspace, so that my conversation context does not bleed into another team's work.
15. As an **end user**, I want the agent to recall Memory across Sessions within my Workspace, so that repeated interactions feel continuous.
16. As an **end user**, I want Memory to auto-expire, deduplicate, and compact without manual cleanup, so that storage stays bounded and relevant.
17. As a **Tenant admin**, I want L0 Memory governance to run automatically with no human review, so that operational overhead stays minimal.
18. As an **Agent builder**, I want to ingest documents into an internal Knowledge Base per Workspace, so that agents can answer from our documentation.
19. As an **Agent builder**, I want to connect an external KB via MCP, so that we can reuse existing RAG infrastructure.
20. As an **Agent builder**, I want hybrid KB search to merge internal and external hits, so that agents get the best available context.
21. As an **Agent builder**, I want to choose orchestration topology (supervisor, pipeline, blackboard) on a Profile, so that multi-agent workflows match our use case.
22. As an **Agent builder**, I want supervisor topology by default with configurable worker Profiles, so that complex tasks decompose naturally.
23. As an **Agent builder**, I want pipeline topology for fixed retrieve-analyze-respond flows, so that ticket and RAG workflows are repeatable.
24. As an **Agent builder**, I want blackboard topology for parallel contributor agents, so that brainstorming-style tasks benefit from concurrent perspectives.
25. As a **QA engineer**, I want Profile-level evaluation with pass rate and P95 latency gates, so that only tested Profiles reach production.
26. As a **QA engineer**, I want optional tool success rate and token caps in the Profile Pin Gate, so that cost and reliability are bounded at release.
27. As a **QA engineer**, I want multi-agent evaluation metrics (handoffs, collaboration score), so that orchestration quality is measurable.
28. As a **Tenant admin**, I want to manually trigger an Evolution Run on a Profile, so that we can improve Skills or prompts on demand.
29. As a **Tenant admin**, I want signal-driven Evolution when eval pass rate drops below threshold for L0/L1 Profiles, so that regressions trigger self-healing without manual monitoring.
30. As a **Tenant admin**, I want L2 Evolution changes to require human review before pin, so that prompt and topology changes stay governed.
31. As a **Tenant admin**, I want L3 resources (credentials, Access Policy) blocked from automatic evolution, so that security boundaries cannot be auto-modified.
32. As a **platform operator**, I want Control Plane APIs for tenant/workspace/profile/session provisioning, so that customer onboarding is automatable.
33. As a **platform operator**, I want DSH session meta injected with tenant/workspace/profile/version IDs, so that Data Plane plugins enforce scope on every turn.
34. As a **platform operator**, I want a headless DSH deployment path for production Data Plane, so that agents run without a dev UI dependency.
35. As a **platform operator**, I want a dev overlay patch for DSH web profile, so that builders can iterate with the standard Harness UI.
36. As a **Developer**, I want domain types and ADRs to define canonical vocabulary, so that all modules speak the same language (Tenant, Workspace, Agent Profile, etc.).
37. As a **Developer**, I want a single ControlPlaneStore interface with memory and Postgres backends, so that local dev and production share the same contracts.
38. As a **Developer**, I want Evolution Service callable over HTTP, so that TypeScript Control Plane and Python GEPA stack stay loosely coupled.
39. As a **Security officer**, I want Access Policy inspired by QwenPaw (allow/deny/ask per tool call), so that dangerous operations require approval.
40. As a **Security officer**, I want sandbox boundaries on tool execution in DSH, so that agents cannot escape their granted workspace.
41. As a **Billing admin**, I want token usage observability per Tenant and Profile, so that consumption can be metered (Phase 3).
42. As an **Agent builder**, I want scheduled Evolution Runs for batch optimization, so that off-peak hours can improve Profiles without user impact (Phase 3).
43. As a **Tenant admin**, I want Marketplace Skills with scanner and L2 approval, so that third-party Skills are vetted before install (Phase 3).
44. As a **Developer**, I want real pgvector embeddings in tenant schema, so that semantic KB search replaces keyword matching (Phase 3).
45. As a **Developer**, I want real GEPA integration in Evolution Service, so that Evolution Runs produce measurably better candidates (Phase 3).

## Implementation Decisions

### Architecture

- **Hybrid deployment**: Control Plane SaaS-capable; Data Plane (Memory, KB, credentials, sandbox) remains in customer domain (ADR 0001).
- **Runtime base**: DeepSeek Harness + Cordis plugins for Data Plane; Pi agent-loop patterns as reference only; Hermes GEPA as separate Python Evolution Service (ADR 0001).
- **Isolation hierarchy**: Tenant (DB schema or dedicated instance) → Workspace (Session + Memory namespace) → Agent Profile (config + eval unit). No per-Profile database (ADR 0001, 0002).

### Control Plane

- HTTP service on configurable port (default 9878); uses `ControlPlaneStore` with in-memory fallback or Postgres when `DATABASE_URL` is set.
- **Endpoints (implemented)**:
  - Tenant/Workspace/Profile/Session CRUD
  - `PUT /tenants/:id/gateway` — Tenant Gateway updates
  - `POST /kb/documents`, `POST /kb/search` — hybrid KB
  - `POST /orchestration/run` — multi-agent execution
  - `POST /evolution/runs`, `POST /evolution/runs/trigger`, `GET /evolution/runs/:id`
- Profile creation validates `modelRoute.provider` against Tenant Gateway `allowedProviders`; rejects with 403 if disallowed.
- Session creation returns DSH session meta keys: `diy.tenantId`, `diy.workspaceId`, `diy.profileId`, `diy.profileVersionId`.

### Data Plane (DSH Plugins)

- **Tenant plugin**: rejects DSH session creation missing required meta keys; extracts `TenantContext` from session meta.
- **Memory plugin**: L0 pipeline on turn-end — TTL → dedup (threshold 0.92) → async compaction when count > 500.
- **MCP pool plugin**: pool key includes `McpPoolScope` (tenant/workspace/session) derived from binding sensitivity or explicit `poolScope`.
- **Orchestrator plugin**: listens for user-message events; delegates to orchestrator module.
- **Patch files**: `cordis.patch.yml` (web dev overlay), `cordis.headless.patch.yml` (production headless).

### Domain Module

- Branded ID types: `TenantId`, `WorkspaceId`, `SessionId`, `ProfileId`, `ProfileVersionId`.
- `GovernanceTier`: L0–L3 for evolution and auto-change policy.
- `resolveModelRoute(gateway, profileRoute)`: returns null if provider not allowed.
- `resolveMcpPoolScope(binding)`: high sensitivity → session; readonly → tenant; default → workspace.
- `DEFAULT_PROFILE_PIN_GATE`: passRate ≥ 0.8, P95 ≤ 5000ms.
- `DEFAULT_EVOLUTION_SIGNAL_THRESHOLD`: 0.75 pass rate for signal trigger.

### Storage

- Platform schema registers tenants; per-tenant schema created dynamically with workspaces, profiles, profile_versions, sessions, memory_entries, private_skills, kb_documents, evolution_runs.
- `IsolationMode`: `schema` (default) | `dedicated`.
- pgvector column on `kb_documents` reserved; requires pgvector extension in Phase 3.

### Knowledge Base

- `HybridKbService`: internal store (keyword match placeholder) + `ExternalMcpKbConnector` stub.
- Profile-level `KnowledgeBaseConfig`: `internal.enabled`, optional `externalMcp` binding.

### Orchestration

- `createOrchestrator(topology)` factory: supervisor (default), pipeline, blackboard.
- Profile-level `OrchestrationConfig`: topology + optional `workerProfileIds`.
- Orchestration result includes `handoffs` array for multi-agent eval.

### Evaluation

- Profile task scoring: keyword containment + latency check; pass threshold 0.8.
- `evaluatePinGate`: passRate, P95 latency, optional tool success rate and token cap.
- `scoreMultiAgentRun`: handoff count, avg latency, collaboration score.

### Evolution

- Python HTTP sidecar (default 9880): `POST /run` invokes GEPA placeholder; returns candidate version and review flag.
- Control Plane merges Evolution Service response into Evolution Run status.
- Signal trigger: only L0/L1 Profiles; skipped if passRate ≥ threshold or tier too high.
- L2 runs start in `awaiting_review`; L3 blocked entirely.

### Governance Tiers (Evolution + Auto-change)

| Tier | Scope | Policy |
|------|-------|--------|
| L0 | Memory | Auto TTL/dedup/compaction |
| L1 | Skill/MCP description | Auto with rollback |
| L2 | Prompt, new Skill, topology | Human review PR |
| L3 | Credentials, Access Policy | No auto change |

### Phase 3 Remaining (Out of Scope for Current Delivery)

- Real GEPA/DSPy `optimize_anything` integration
- pgvector embedding pipeline
- DSH live E2E with installed `@deepseek-ai/deepseek-harness`
- Marketplace Skill scanner + approval UI
- Scheduled Evolution trigger
- Full Profile Pin Gate enforcement on pin API
- Access Policy engine (QwenPaw-inspired YAML rules)
- Billing/token metering

### Prototype-Encoded Decisions

**Governance tier auto-promote (Evolution Service):**

```python
def can_auto_promote(tier: GovernanceTier) -> bool:
    return tier in (GovernanceTier.L0, GovernanceTier.L1)
```

**MCP pool scope resolution:**

```typescript
if (binding.poolScope) return binding.poolScope;
if (binding.sensitivity === "high") return "session";
if (binding.sensitivity === "readonly") return "tenant";
return "workspace";
```

**Memory L0 pipeline order:** TTL → dedup → compaction (async when `asyncCompaction: true`).

## Testing Decisions

### What Makes a Good Test

- Test **external behavior** at module boundaries, not internal maps or private state.
- Prefer **one high seam** over many shallow unit tests when behavior is integration-heavy.
- Use domain vocabulary in assertions (Tenant, Workspace, Agent Profile, Evolution Run).
- Do not assert on log output, internal Map sizes, or implementation-specific error strings unless they are part of the public contract.

### Primary Test Seam (Proposed)

**Control Plane HTTP API — black-box integration tests**

Single seam exercising the full provisioning and Phase 2 flows:

1. `POST /tenants` → `POST /workspaces` → `POST /profiles`
2. Assert gateway rejects disallowed provider on profile create
3. `POST /sessions` → verify `dshMeta` keys present
4. `POST /kb/documents` + `POST /kb/search` → hit returned
5. `POST /orchestration/run` → plan + handoffs returned
6. `POST /evolution/runs/trigger` with low passRate → run created for L1 Profile
7. `POST /evolution/runs/trigger` with high passRate → skipped

This seam matches manual validation already performed and requires no DSH installation for CI.

**Please confirm this seam matches your expectations before agent implementation begins.**

### Secondary Seams (Pure Functions — Only Where High Seam Is Insufficient)

| Module | Functions | Why |
|--------|-----------|-----|
| domain | `resolveModelRoute`, `resolveMcpPoolScope` | Deterministic policy logic |
| eval-harness | `evaluatePinGate`, `scoreMultiAgentRun`, `percentile` | Numeric gate boundaries |
| memory plugin | `runGovernancePipeline` | Stage ordering and counts |
| orchestrator | `createOrchestrator(...).execute` | Topology-specific handoff shapes |

No prior test art exists in the repo; establish pattern with Control Plane integration tests first.

### Not Testing Directly

- DSH Cordis plugin lifecycle (requires Harness install; defer to manual/Phase 3 E2E)
- Postgres schema migration (optional docker-compose job; separate from main seam)
- Python GEPA optimization internals (mock Evolution HTTP in Control Plane tests)

## Out of Scope

- GPU model training or fine-tuning
- Multi-region Control Plane HA (single-node MVP)
- Full SaaS billing and metering UI
- Real-time collaborative editing of Profiles
- MCP Resources/Prompts support (DSH mcp-client tools-only)
- Mobile or channel integrations (DingTalk, Feishu, etc.)
- Replacing DSH with a from-scratch runtime
- Forking QwenPaw or AgentScope as a direct dependency

## Further Notes

- DSH is in developer preview; wrap plugin interfaces behind stable `@diy-agent/*` packages to absorb breaking changes.
- Default ports: Control Plane 9878, Evolution 9880; avoid 8787 (commonly occupied).
- Reference frameworks: QwenPaw (ToB governance, Hub isolation), Hermes+GEPA (self-evolution), Pi (minimal loop), DeepSeek Harness (Cordis plugins).
- Issue tracker publish pending: no git remote or `gh` auth configured; this spec lives at `docs/spec/001-diy-agent-platform.md` with label **ready-for-agent**.
