# Spec: Knowledge Base Runtime Migration to Data Plane

**Status:** ready-for-agent  
**Source:** Architecture review + Grilling Rounds 1–3 (KB deepen candidate #2)  
**Domain glossary:** `CONTEXT.md`  
**Related ADR:** `docs/adr/0001-kb-runtime-on-data-plane.md` (to be created)

---

## Problem Statement

Knowledge Base 检索与向量索引当前在 Control Plane 内执行（`HybridKbService` 绑定 CP HTTP `/kb/search` 与 `/kb/documents`），与平台领域模型冲突：Control Plane 不应存储 KB 正文，Knowledge Base 应在 Data Plane / tenant schema 内运行。这同时违背 Pi 风格「turn 内自包含 runtime」——Agent 在 Session 中无法通过 DSH tool seam 检索 KB，而必须跨 plane 调用 CP。企业客户还要求文档与 embedding 留在客户域；现有实现把 Postgres pgvector 连接与 ingest 逻辑放在 CP，增加合规与部署拓扑摩擦。

## Solution

将 Knowledge Base **runtime depth** 下沉至 Data Plane：新建 **`dsh-kb-plugin`**（DSH adapter），在 turn loop 内通过 **`kb_search` tool**（默认）或 **`retrievalMode: auto`**（Phase B）执行混合检索；`@diy-agent/kb-rag` 保留 RRF / embedding / store adapter depth。Data Plane HTTP 暴露 **`POST /kb/search`**，与 plugin 共用 **`KbRuntime` module**。Control Plane 过渡期保留 **`POST /kb/search` proxy**（deprecated）；Phase B 将 ingest 正文迁至 Data Plane，CP 仅维护 **Kb Document Registry** 元数据（无正文）。分两阶段交付：**Phase A = search**，**Phase B = ingest + registry**。

---

## User Stories

### 架构与合规

1. As a Tenant Admin, I want KB document bodies and vector embeddings to remain in Data Plane tenant schema, so that document content never copies to Control Plane.
2. As a Platform operator, I want Control Plane to align with CONTEXT.md (no KB plaintext on CP), so that hybrid C-tier deployment matches customer data residency expectations.
3. As a Workspace Builder, I want KB retrieval to occur inside the DSH Session turn loop, so that agents behave like Pi-style lightweight runtimes without cross-plane hot paths.
4. As an Enterprise Data Plane operator, I want KB search to work when Control Plane is reachable only for profile sync—not for every query—so that retrieval locality stays in the customer VPC.

### Phase A — Search on Data Plane

5. As a Data Plane runtime, I want a Standard DSH plugin bundle that includes Knowledge Base search, so that KB is a first-class Data Plane concern alongside Memory and MCP pool.
6. As an End User chatting in a Session, I want the Agent Profile to expose a `kb_search` tool by default, so that the LLM decides when to retrieve documents.
7. As a Workspace Builder, I want `KnowledgeBaseConfig.retrievalMode` to support `tool` (default) and `auto`, so that Enterprise can opt into automatic RAG injection later without schema churn.
8. As a Data Plane runtime, I want hybrid search to fuse internal vector hits with external MCP KB results via reciprocal rank fusion, so that federated enterprise search continues to work after migration.
9. As a Data Plane runtime, I want internal KB search to use tenant schema Postgres pgvector when `DIY_DATABASE_URL` and schema env are configured, so that production deployments persist vectors in customer DB.
10. As a developer running local tests, I want KB internal store to fall back to in-memory adapter when DB env is absent, so that CI does not require Postgres for every test.
11. As a Data Plane runtime, I want `kbConfig` read from cached Agent Profile snapshot (tenant-plugin pull or Enterprise profile-sync cache), so that search config is authoritative without per-query Control Plane round-trips.
12. As an Enterprise Data Plane, I want snapshot resolution to prefer profile-sync pinned cache then tenant-plugin cache, so that offline Enterprise sessions and Standard sessions behave consistently.
13. As a Data Plane runtime, I want KB search to fail clearly with `kb_config_unavailable` when snapshot cache misses, so that agents never run with silent empty config.
14. As a Tenant Admin, I want `kb_search` to pass through Access Policy `tool/before-call` with default allow, so that readonly retrieval is not blocked by deny-by-default high-write MCP rules.
15. As a Tenant Admin, I want external MCP KB hits to retain `source: external_mcp` in results and traces, so that compliance can distinguish federated vs internal retrieval.
16. As a Workspace Builder, I want external MCP KB leg to use direct HTTP client in Phase A, so that migration is not blocked on MCP warm-pool coupling.
17. As a developer, I want to call `POST /kb/search` on Data Plane HTTP (:3080), so that non-DSH clients and admin scripts can search without a live Session.
18. As a Tenant Admin using existing integrations, I want Control Plane `POST /kb/search` to proxy to Data Plane during transition, so that CLI and docs do not break immediately.
19. As a Platform operator, I want OpenAPI to mark Control Plane KB search as deprecated and document Data Plane KB search, so that integrators migrate to the correct plane.
20. As a Platform operator, I want CP→DP proxy authenticated via shared internal token in production, so that KB search HTTP is not anonymously callable outside the cluster.

### Phase B — Ingest + Registry on Control Plane metadata only

21. As a Workspace Builder, I want to ingest KB documents via existing Control Plane `POST /kb/documents` API during Phase B, so that CLI and README workflows remain stable while bodies move to Data Plane.
22. As a Control Plane, I want ingest requests forwarded to Data Plane for vector indexing, so that embeddings are written only in tenant schema.
23. As a Control Plane, I want to persist Kb Document Registry entries (id, workspaceId, profileId, title, contentHash, createdAt) without content, so that admin listing and audit remain on CP while bodies stay in DP.
24. As a Control Plane, I want registry writes to occur only after successful Data Plane ingest, so that ghost metadata never appears when indexing fails.
25. As a Workspace Builder, I want document `contentHash` computed as SHA-256 of UTF-8 content, so that dedup and compliance align with Skill catalog hash conventions.
26. As a Workspace Builder, I want `retrievalMode: auto` to run search on turn-start using the latest user message and prepend top-3 hits as system context, so that RAG works without explicit tool calls when configured.
27. As a Workspace Builder, I want auto mode to skip registering `kb_search` tool, so that tool and auto modes are mutually exclusive.
28. As a Data Plane operator, I want dedicated-tenant deployments to use dedicated database URL with `public` schema for KB tables, so that Enterprise isolation mode matches existing tenant storage rules.

### 运维与部署

29. As an Enterprise operator, I want Helm Data Plane values for database URL, tenant DB schema, and internal auth token, so that VPC deployments configure KB Postgres without Control Plane holding DB credentials for search.
30. As a developer, I want `cordis.patch.yml` Standard bundle to include the KB plugin alongside the existing five plugins, so that docker-compose / local DSH runs KB out of the box.
31. As a Data Plane service account, I want trace upload to continue recording `kb_search` in toolCalls when used, so that Pin Gate and Evolution retain tool success evidence.
32. As a Platform architect, I want ADR-0001 to record KB runtime placement and phased migration trade-offs, so that future architecture reviews do not re-litigate CP-hosted KB.

---

## Implementation Decisions

### Grilling consensus (Rounds 1–3)

| Decision | Outcome |
|----------|---------|
| Deepen target | Knowledge Base module sinks to Data Plane (not CP route split alone) |
| Goals | Pi turn-loop locality + ToB data residency (both) |
| CP long-term role | Kb Document Registry metadata only; no KB plaintext |
| Transition | CP `/kb/search` proxies to Data Plane; deprecated in OpenAPI |
| Module shape | New `dsh-kb-plugin` as DSH adapter over `@diy-agent/kb-rag` |
| Turn integration | `retrievalMode: tool \| auto`, default `tool`; auto defers to Phase B |
| Storage | Postgres pgvector in tenant schema via Data Plane env; memory adapter for tests |
| Delivery phases | **Phase A:** search only. **Phase B:** ingest + registry + auto mode |
| Plugin inject | `inject: ["tools"]`; register `kb_search` handler |
| kbConfig source | Unified snapshot resolver: profile-sync cache → tenant-plugin cache → fail |
| External MCP leg | Direct HTTP client Phase A; optional MCP pool adapter later |
| Shared runtime | `KbRuntime` module inside KB plugin package; HTTP + tool share it |
| Bundle | Add plugin to Standard `cordis.patch.yml` (sixth plugin) |
| CP Phase A removal | Remove CP `HybridKbService` for search; keep ingest until Phase B |
| CP→DP auth | `DIY_DATA_PLANE_INTERNAL_TOKEN` (optional dev skip) |
| ADR | Write ADR-0001 at implementation start |

### Domain model extensions

Add to `KnowledgeBaseConfig`:

```
retrievalMode?: "tool" | "auto"   // default "tool"
```

Add **Kb Document Registry** glossary term to `CONTEXT.md` (Phase B):

> Workspace-scoped index of ingested KB documents; Control Plane stores documentId, title, contentHash, and timestamps; document body and embeddings remain in Data Plane tenant schema.

Add domain type (Phase B):

```
KbDocumentRegistryEntry {
  id: string
  workspaceId: WorkspaceId
  profileId: ProfileId
  title: string
  contentHash: string   // sha256 hex of UTF-8 content
  createdAt: Date
}
```

### KbRuntime module interface

Export factory **`createKbRuntime(deps)`** returning:

```
{
  search(input: {
    workspaceId: WorkspaceId
    query: string
    kbConfig: KnowledgeBaseConfig
    tenantId?: TenantId
  }): Promise<KbSearchResult>

  ingest(input: { ... }): Promise<KbDocument | null>   // Phase B
}
```

Dependencies injectable for tests: `KbStore` adapter, optional `McpKbSearchClient`, Postgres pool + schema resolver. `@diy-agent/kb-rag` keeps `HybridKbService`, RRF, embedding; `KbRuntime` owns snapshot resolution and env-based store selection.

### Snapshot resolver

Single helper used by plugin and HTTP handler:

1. If Enterprise profile-sync cache hit → read `snapshot.kbConfig`
2. Else if tenant-plugin snapshot cache hit → read `snapshot.kbConfig`
3. Else throw / return `kb_config_unavailable`

Session meta supplies `workspaceId`, `tenantId`, `profileId`, `profileVersionId` only—not duplicated kbConfig JSON.

### DSH plugin behavior

- **tool mode (default):** register `kb_search` with args `{ query: string }`; handler calls `KbRuntime.search`; result JSON returned to LLM; policy plugin evaluates via existing `tool/before-call`.
- **auto mode (Phase B):** hook `session/turn-start`; search using last user message; prepend top-3 hits as system context; do not register `kb_search`.

### Data Plane HTTP contract

**POST /kb/search**

Request:

```
{
  profileId: ProfileId
  profileVersionId?: ProfileVersionId
  workspaceId: WorkspaceId
  tenantId?: TenantId
  query: string
}
```

Response: existing `KbSearchResult` shape (`query`, `hits[]` with `documentId`, `title`, `snippet`, `score`, `source`).

Auth: optional `Authorization: Bearer <DIY_DATA_PLANE_INTERNAL_TOKEN>` (required in Helm prod).

### Control Plane Phase A changes

- Remove in-process `HybridKbService` / `resolveKbService` for search path.
- Implement `/kb/search` as HTTP forward to Data Plane base URL (env `DIY_DATA_PLANE_URL`) with internal token.
- Keep `/kb/documents` ingest on CP until Phase B (known temporary violation of target architecture).

### Control Plane Phase B changes

- `/kb/documents`: validate profile → forward body to Data Plane ingest → on success write `KbDocumentRegistryEntry` to store (MemoryStore + PostgresStore).
- No `content` field in registry or CP audit payload.

### Postgres / tenant schema on Data Plane

Env resolution:

- **Schema mode:** `DIY_DATABASE_URL` + `DIY_TENANT_DB_SCHEMA` → `PostgresKbStore`
- **Dedicated mode:** `DIY_DEDICATED_DATABASE_URL` → schema `public`
- **Missing env:** `InternalKbStore` (tests / dev)

Do not query Control Plane for schema at search time.

### Helm Data Plane values (additions)

- `databaseUrl`
- `tenantDbSchema`
- `dataPlaneInternalToken`
- Existing `controlPlaneUrl`, `tenantId` unchanged

### OpenAPI

- Control Plane: deprecate `/kb/search`; note proxy target.
- New Data Plane OpenAPI stub: `/kb/search`, `/health` (ingest route Phase B).

### ADR-0001

Record: KB runtime on Data Plane; CP registry-only metadata; Phase A/B split; transitional CP proxy; snapshot cache priority; rationale vs Pi + CONTEXT.md.

---

## Testing Decisions

### What makes a good test

Assert **observable behavior at module interfaces**—HTTP status/body, tool handler outputs, search hit fusion outcomes—not plugin registration order or private `HybridKbService` fields. Mock external MCP at the `McpKbSearchClient` seam; mock Postgres via `InternalKbStore` injection.

### Recommended test seams

Grilling chose a **split seam** strategy (differs from platform-wide «CP-only primary seam» for this refactor):

| Priority | Seam | What it proves | Prior art |
|----------|------|----------------|-----------|
| **Primary (Phase A)** | **Data Plane HTTP `POST /kb/search`** | End-to-end search: snapshot config → hybrid hits → auth token | `services/data-plane` profile-sync HTTP tests; `sprint-2a/2b` search assertions |
| **Secondary** | **`@diy-agent/kb-rag` unit** | RRF fusion, internal + external MCP legs, embedding scoring | Existing `packages/kb-rag/test/fusion-external.test.ts` |
| **Secondary** | **`dsh-kb-plugin` unit** | `kb_search` tool handler, snapshot resolver miss/success, policy passthrough | `dsh-policy-plugin/test`, `dsh-trace-plugin/test` |
| **Tertiary (thin)** | **Control Plane proxy** | Deprecated `/kb/search` forwards to mock Data Plane; no local `HybridKbService` | `createControlPlaneServer` factory in phase/sprint tests |

**Ideal convergence (future):** once proxy is removed, Primary seam collapses to Data Plane HTTP only.

Phase B adds: CP ingest forward + registry entry without content; auto mode turn-start injection tests in plugin seam.

### Regression baseline

All existing **64/64** tests must pass after Phase A; sprint-2a/2b tests migrate from «CP runs KB» to «CP proxies / kb-rag direct».

---

## Out of Scope

- MCP warm-pool adapter for external KB leg (future optional second adapter)
- DP-native `POST /kb/documents` as primary client API (Phase B uses CP orchestrated forward only)
- Removing Control Plane `/kb/documents` in Phase A
- Conversation content or KB snippets stored in Control Plane audit log
- New vector database product (remain Postgres pgvector in tenant schema)
- Pin Gate rule changes specific to KB tool success rates
- Full DSH turn-start event in platform core (plugin uses available hooks; auto mode Phase B)
- Marketplace / Skill Catalog changes
- Re-litigating tenant schema vs dedicated isolation (follow existing tenant storage ADR patterns)

---

## Further Notes

### Delivery checklist

**Phase A**

- [ ] Domain: `retrievalMode` on `KnowledgeBaseConfig`
- [ ] `dsh-kb-plugin` + `KbRuntime` + Standard patch entry
- [ ] Data Plane HTTP `/kb/search`
- [ ] CP search proxy; remove CP search runtime
- [ ] OpenAPI deprecation + Data Plane stub
- [ ] Tests per seam table; 64/64 green
- [ ] CONTEXT.md: Kb Document Registry term (glossary prep for Phase B)
- [ ] ADR-0001

**Phase B**

- [ ] CP Kb Document Registry store API
- [ ] CP ingest forward + transactional registry write
- [ ] Data Plane ingest endpoint
- [ ] `retrievalMode: auto` turn-start behavior
- [ ] Helm env for DB + internal token

### Issue tracker

**Label:** `ready-for-agent`

Publish as GitHub issue against `ds-new/zhousi-agent` when `gh` CLI is available:

```bash
gh issue create --repo ds-new/zhousi-agent \
  --title "Spec: Knowledge Base runtime migration to Data Plane (Phase A/B)" \
  --label "ready-for-agent" \
  --body-file docs/specs/kb-data-plane-migration.md
```
