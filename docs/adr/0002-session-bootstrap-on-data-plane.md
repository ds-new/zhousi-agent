# ADR-0002: Session Bootstrap on Data Plane

**Status:** Accepted  
**Date:** 2026-09-08

## Context

Control Plane returns Profile version snapshots, Workspace Access Policy, Credential Ref IDs, and MCP Catalog metadata, but Data Plane DSH plugins did not automatically apply this configuration at Session start. `dsh-tenant-plugin` asynchronously pulled snapshots without Service Account authentication and ignored the `policy` field. `dsh-policy-plugin` required manual `setWorkspacePolicy`. MCP `pending` approval was stored in Control Plane only. This broke the QwenPaw ToB pattern: governance configured in Control Plane must enforce inside the Data Plane turn loop.

Knowledge Base config (ADR-0001) already moved to Data Plane but used a separate snapshot cache resolver, duplicating cache priority logic.

## Decision

1. Introduce **`dsh-bootstrap-plugin`** as the Session Bootstrap module.
2. On **`sessions/create`**, synchronously materialize **`ProfileBootstrapBundle`** via authenticated Control Plane pulls:
   - `GET /profiles/{id}/versions/{vid}` (snapshot, policy, credentialRefIds)
   - `GET /mcp/catalog?tenantId=` (with Service Account auth added)
3. Store bundle in a **shared cache** keyed by `(profileId, profileVersionId)`; inject `policy` into policy-plugin.
4. Derive **`blockedMcpServers`** from catalog entries where `approvalStatus !== 'approved'`; enforce via MCP pool acquire and policy tool gate.
5. **Slim `dsh-tenant-plugin`** to Session meta validation only; remove pull/cache.
6. **Enterprise**: extend `profile.pinned` webhook and profile-sync reconcile payloads with `policy`, `credentialRefIds`, `mcpCatalog`; materialize the same bundle offline.
7. **Credential refs**: lazy vault decrypt on `tool/before-call` (Enterprise overlay), not at Session create.
8. **KB plugin** reads `kbConfig` from bundle (Phase 4); remove dual-cache resolver.
9. **Production fail-fast** on bootstrap failure; optional `DIY_BOOTSTRAP_DEV_DEGRADE` for non-production only.
10. **No mid-session policy refresh** — Session bound to pinned Profile version semantics.

## Consequences

- Positive: QwenPaw runtime enforcement closure; single cache leverage for KB/policy/MCP; fixes SA/auth gap on profile pull.
- Positive: Enterprise offline Sessions receive full governance bundle after webhook/reconcile.
- Negative: Session create latency increases by one extra CP round-trip (catalog GET).
- Negative: Phased delivery (policy first, MCP blocklist, vault, KB migration) leaves temporary gaps between phases.

## Alternatives considered

- **Extend tenant-plugin only**: rejected — violates single-responsibility; cache duplication persists.
- **Single merged CP bootstrap endpoint**: rejected for Phase 1 — two existing endpoints sufficient.
- **Embed policy in snapshot**: rejected — duplicates workspace policy source of truth (Phase 4 profile eval already returns policy separately).

## 2026-09-12 implementation clarification

The native Node runtime uses `POST /sessions/resolve`, now backed by a single `resolveSessionBootstrap` store operation. It validates the session token and optionally consumes RPM before returning the pinned snapshot, bound skill hashes, current policy and MCP catalog. This optimization is request-scoped, with no cross-turn cache. Native turns retain their existing current-policy refresh behavior. Decision 10 above describes the DSH plugin bootstrap path; this change does not replace its cache or silently unify these two policy lifecycles.

## Related documents

- ADR-0001: Knowledge Base runtime on Data Plane
- Spec: `docs/specs/session-bootstrap-data-plane.md`
