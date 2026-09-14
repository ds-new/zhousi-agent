# ADR-0003: Agent hot-path storage and retrieval boundaries

**Status:** Accepted  
**Date:** 2026-09-12

## Context

The native agent read a Workspace's entire memory archive on ordinary turns, selected the wrong end of recent memory, and queried the control-plane store seven times to resolve a session with quota checking. PostgreSQL restored mutable catalog state into one shared instance and serialized read snapshots. Eval traces were duplicated in SQL and checkpoints. Native KB always retrieved, regardless of tool mode, and hybrid sources ran sequentially.

## Decision

1. `WorkspaceMemory` owns context order, head/archive storage, legacy migration and governance. The head uses `{format:2,entries}`; archive data has a separate artifact kind. PostgreSQL record locks and the existing Session transaction retain atomicity. Maintenance scans metadata with a keyset cursor and writes only changes.
2. `resolveSessionBootstrap` validates the token and produces the request's execution bundle within one store operation. Optional quota checking remains a write. No cross-turn cache is introduced. The native and DSH policy lifecycles remain distinct as clarified in ADR-0002.
3. Each PostgreSQL operation receives its own catalog maps. Known tenants use targeted reads and per-tenant scheduling with at most eight operations per instance. Read operations omit before-state serialization. Trace SQL is authoritative; migration verifies duplicate IDs before removing checkpoint copies. Other catalog aggregates remain JSON checkpoints.
4. `SessionKnowledge` owns native tool/auto semantics and approved KB configuration. Model-selected `kb_search` participates in ordinary policy and approval handling. Only approved readonly hybrid retrieval overlaps its two sources; errors, cancellation and time budgets propagate without partial-success fallback.
5. Checkpoint updates compare the original loaded JSONB within the business transaction. A conflicting update fails the whole transaction rather than overwriting another replica. Trace writes and latest-publication-evidence reads share a Profile advisory lock on that same physical business transaction. Platform routing locks alone cannot close the interval between checking one connection and committing another.

## Consequences

- Ordinary memory traffic scales with the active head, without including unchanged archives. Retirement and migration still require archive work.
- Session bootstrap reduces repeated restoration without making policy revocation stale across native turns.
- Independent tenant operations can progress together without sharing mutable business state. Same-tenant writes, cold entity lookup, global administration and large JSON aggregates retain their existing costs.
- SQL trace retention and publication evidence no longer depend on checkpoint copies. Upgrading requires a coordinated writer drain and a backup; old writers must not repopulate the removed trace copies.
- Database commit acknowledgements can still be lost. CAS prevents stale overwrites but does not provide automatic retry semantics for every control-plane mutation.
- Tool-mode KB avoids unconditional retrieval; auto mode with an ask policy fails explicitly and should be changed to tool mode when human approval is required. Already-dispatched database queries still rely on database statement timeout.

## Alternatives considered

- Cross-turn configuration caching: avoided because native policy/catalog refresh semantics must remain intact.
- Parallel operations over shared restored maps: rejected because tenant state could mix or overwrite another operation.
- Full catalog normalization: deferred; trace extraction removes the growing evaluation payload without replacing every business persistence contract at once.
- Concurrent normal/high external retrieval: rejected because catalog sensitivity does not authorize speculative overlap of possible effects.

## Related

- [Implementation, tests and local probes](../reports/architecture-performance-implementation.md)
- [Runtime contracts](../operations/runtime.md)
- ADR-0001 and ADR-0002
