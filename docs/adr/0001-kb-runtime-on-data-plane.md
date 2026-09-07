# ADR-0001: Knowledge Base Runtime on Data Plane

**Status:** Accepted  
**Date:** 2026-09-07

## Context

Sprint 2a/2b implemented Knowledge Base ingest and hybrid search inside the Control Plane HTTP server (`HybridKbService` on `/kb/search` and `/kb/documents`). This contradicts `CONTEXT.md`: Control Plane must not store KB plaintext, and Knowledge Base retrieval belongs in the Data Plane DSH runtime alongside Memory and MCP execution.

Agents also could not search KB inside the turn loop without cross-plane calls, misaligned with Pi-style lightweight Session runtimes.

## Decision

1. **Move KB runtime depth to Data Plane** via `@diy-agent/dsh-kb-plugin` and a shared `KbRuntime` module (adapter over `@diy-agent/kb-rag`).
2. **Expose Data Plane HTTP** `POST /kb/search` (Phase A) and `POST /kb/documents` (ingest forwarding, Phase A).
3. **Register `kb_search` tool** in the Standard DSH bundle (`inject: ["tools"]`); default `KnowledgeBaseConfig.retrievalMode` is `"tool"`.
4. **Control Plane transition**: deprecate `/kb/search` and proxy to Data Plane; keep `/kb/documents` as proxy until Phase B adds **Kb Document Registry** metadata-only entries.
5. **Snapshot config**: resolve `kbConfig` from profile-sync cache (Enterprise) then tenant-plugin cache; fail with `kb_config_unavailable` on miss.
6. **Auth**: optional `DIY_DATA_PLANE_INTERNAL_TOKEN` for CP→DP HTTP (required in production Helm).
7. **Postgres**: Data Plane reads `DIY_DATABASE_URL` + `DIY_TENANT_DB_SCHEMA` or `DIY_DEDICATED_DATABASE_URL`; fallback to in-memory store for tests.

## Consequences

- Positive: KB locality in customer VPC; Pi-aligned turn tool seam; CP thins toward registry-only metadata (Phase B).
- Positive: `@diy-agent/kb-rag` remains the deep module for RRF and store adapters; tests split by interface (kb-rag, plugin, DP HTTP, thin CP proxy).
- Negative: Phase A requires running Data Plane for KB search even when using CP API (transitional proxy).
- Negative: Phase A ingest still uses CP route as orchestrator (forward only); full Kb Document Registry deferred to Phase B.

## Alternatives considered

- **Keep KB on Control Plane**: rejected — violates data residency and CONTEXT vocabulary.
- **CP-only route split without Data Plane plugin**: rejected — does not fix turn-loop seam or Pi alignment.
- **Big-bang migrate ingest + registry**: rejected — phased A (search) then B (registry) reduces risk.
