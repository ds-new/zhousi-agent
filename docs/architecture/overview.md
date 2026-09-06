# Architecture Overview

## Layered Model

```
┌─────────────────────────────────────────────────────────────┐
│                    Control Plane (SaaS)                      │
│  Tenant Admin │ Profile Versioning │ Eval Orchestrator       │
│  Evolution Scheduler │ Audit │ Billing                       │
└──────────────────────────┬──────────────────────────────────┘
                           │ API (tenant-scoped)
┌──────────────────────────▼──────────────────────────────────┐
│              Data Plane (customer domain)                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │ DSH Runtime │  │ Memory Store │  │ KB / Vector Index   │ │
│  │ (Cordis)    │  │ (workspace)  │  │ (tenant-scoped)     │ │
│  └──────┬──────┘  └──────────────┘  └─────────────────────┘ │
│         │                                                      │
│  ┌──────▼──────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │ MCP Pool    │  │ Skill Registry│  │ Sandbox / Policy   │ │
│  │ (warm conn) │  │ (L1/L2 tiers) │  │ (QwenPaw-inspired) │ │
│  └─────────────┘  └──────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│              Evolution Service (Python sidecar)              │
│  GEPA/DSPy │ Eval Harness │ Candidate → Review → Promote      │
└─────────────────────────────────────────────────────────────┘
```

## Isolation Matrix

| Resource        | Tenant | Workspace | Session | Agent Profile |
|-----------------|--------|-----------|---------|---------------|
| Database        | ✓ own  | namespace | row key | config ref    |
| Memory          |        | ✓ scope   | optional thread | read policy |
| MCP credentials | ✓ vault| bind list | inherit | bind list     |
| KB index        | ✓      | ✓ filter  |         | retrieval cfg |
| Eval results    | ✓      | ✓         | ✓ trace | ✓ primary     |

## MVP Scope (Phase 1)

- Tenant + Workspace CRUD
- Agent Profile CRUD with version pinning
- Session store with workspace isolation
- Memory store with L0 self-governance (TTL, dedup, compaction)
- MCP connection pool with warm start
- Model provider routing (custom endpoint per profile)
- Profile-level eval harness (task suite + trace scoring)

## Phase 2 (implemented)

- Hybrid KB RAG (`@diy-agent/kb-rag`) — internal index + external MCP placeholder
- Multi-agent orchestration (`@diy-agent/orchestrator`) — supervisor / pipeline / blackboard
- Evolution Run API — manual + signal trigger; Python HTTP sidecar (`:9880`)
- DSH headless overlay — `cordis.headless.patch.yml` + `scripts/run-data-plane.sh`
- Multi-agent eval metrics in `@diy-agent/eval-harness` (Phase 2 scoring)

## Phase 3 (next)

- GEPA/DSPy real integration in evolution sidecar
- pgvector extension + embedding pipeline
- DSH live integration test with `dsh --patch`
- Marketplace Skill scanner + L2 approval UI
