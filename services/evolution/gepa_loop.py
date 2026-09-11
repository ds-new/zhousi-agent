"""GEPA-style multi-round eval → mutate → re-eval loop (evolution sidecar fallback).

Control Plane orchestrates GEPA by default via golden-task-runner agent re-eval.
Enable this module with DIY_GEPA_ENABLED=1 on the evolution service only.
"""
from __future__ import annotations

import copy
import os
import re
from typing import Any, Callable

DEFAULT_GEPA_MAX_ROUNDS = 3
DEFAULT_GEPA_MIN_PASS_RATE = 0.85


def _max_rounds() -> int:
    return max(1, int(os.environ.get("DIY_GEPA_MAX_ROUNDS", str(DEFAULT_GEPA_MAX_ROUNDS))))


def _min_pass_rate() -> float:
    return float(os.environ.get("DIY_GEPA_MIN_PASS_RATE", str(DEFAULT_GEPA_MIN_PASS_RATE)))


def score_task(task: dict[str, Any], output: str, latency_ms: int) -> tuple[float, bool]:
    expected = task.get("expectedContains") or []
    if expected:
        lowered = output.lower()
        hits = sum(1 for token in expected if str(token).lower() in lowered)
        score = hits / len(expected)
    else:
        score = 1.0 if output else 0.0
    max_latency = task.get("maxLatencyMs")
    latency_ok = max_latency is None or latency_ms <= max_latency
    return score, score >= 0.8 and latency_ok


def version_traces(traces: list[dict[str, Any]], version_id: str | None) -> list[dict[str, Any]]:
    if not version_id:
        return list(traces)
    return [trace for trace in traces if trace.get("profileVersionId") == version_id]


def evaluate_pass_rate(
    tasks: list[dict[str, Any]],
    traces: list[dict[str, Any]],
    version_id: str | None,
) -> float:
    if not tasks:
        return 0.0
    scoped = version_traces(traces, version_id)
    passed = 0
    for index, task in enumerate(tasks):
        trace = scoped[index] if index < len(scoped) else None
        output = str(trace.get("output", "")) if trace else ""
        latency_ms = int(trace.get("latencyMs", 999999)) if trace else 999999
        _, ok = score_task(task, output, latency_ms)
        if ok:
            passed += 1
    return passed / len(tasks)


def apply_mutation(snapshot: dict[str, Any], mutation: dict[str, Any]) -> dict[str, Any]:
    next_snapshot = copy.deepcopy(snapshot)
    path = str(mutation.get("path", ""))
    after = str(mutation.get("after", ""))

    if path == "prompt/system":
        next_snapshot["systemPrompt"] = after
        return next_snapshot

    mcp_match = re.fullmatch(r"mcp/([^/]+)/description", path)
    if mcp_match:
        server_name = mcp_match.group(1)
        bindings = list(next_snapshot.get("mcpBindings") or [])
        binding = next(
            (entry for entry in bindings if entry.get("serverName") == server_name),
            None,
        )
        if binding is None:
            binding = {"serverName": server_name, "transport": "stdio"}
            bindings.append(binding)
        binding["description"] = after
        next_snapshot["mcpBindings"] = bindings
        return next_snapshot

    skill_match = re.fullmatch(r"skills/(.+)", path)
    if skill_match:
        skill_key = skill_match.group(1)
        prompt = str(next_snapshot.get("systemPrompt") or "")
        next_snapshot["systemPrompt"] = f"{prompt}\n\n[Evolved skill {skill_key}]\n{after}"
        return next_snapshot

    return next_snapshot


def apply_mutations(snapshot: dict[str, Any], mutations: list[dict[str, Any]]) -> dict[str, Any]:
    working = copy.deepcopy(snapshot)
    for mutation in mutations:
        working = apply_mutation(working, mutation)
    return working


def _mutation_tool_names(mutations: list[dict[str, Any]]) -> set[str]:
    names: set[str] = set()
    for mutation in mutations:
        match = re.fullmatch(r"mcp/([^/]+)/description", str(mutation.get("path", "")))
        if match:
            names.add(match.group(1))
    return names


ProposeFn = Callable[[dict[str, Any]], list[dict[str, Any]]]


def run_gepa_loop(body: dict[str, Any], propose: ProposeFn, evaluate: Callable[[dict[str, Any]], list[dict[str, Any]]] | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    tasks = list(body.get("evalTasks") or [])
    if tasks and evaluate is None:
        raise RuntimeError("agent_evaluator_required")
    traces = list(body.get("traces") or [])
    version_id = body.get("baseVersionId")
    snapshot = copy.deepcopy(body.get("snapshot") or {})
    if not isinstance(snapshot, dict):
        snapshot = {}

    baseline_pass_rate = evaluate_pass_rate(tasks, traces, version_id)
    rounds_log: list[dict[str, Any]] = [{"round": 0, "passRate": baseline_pass_rate}]

    if not tasks:
        mutations = propose(body)
        return mutations, {
            "rounds": rounds_log,
            "bestRound": 0,
            "baselinePassRate": baseline_pass_rate,
            "finalPassRate": baseline_pass_rate,
            "evalScoreDelta": 0.0,
        }

    if baseline_pass_rate >= _min_pass_rate():
        return propose(body), {
            "rounds": rounds_log,
            "bestRound": 0,
            "baselinePassRate": baseline_pass_rate,
            "finalPassRate": baseline_pass_rate,
            "evalScoreDelta": 0.0,
        }

    best_pass_rate = baseline_pass_rate
    best_mutations = propose(body)
    best_round = 0
    working_snapshot = snapshot
    working_traces = traces

    for round_num in range(1, _max_rounds() + 1):
        current_pass_rate = evaluate_pass_rate(tasks, working_traces, version_id)
        if current_pass_rate >= _min_pass_rate():
            best_pass_rate = current_pass_rate
            best_round = round_num - 1 if round_num > 1 else 0
            break

        round_body = {
            **body,
            "snapshot": working_snapshot,
            "traces": working_traces,
        }
        mutations = propose(round_body)
        if not mutations:
            break

        working_snapshot = apply_mutations(working_snapshot, mutations)
        working_traces = evaluate(working_snapshot) if evaluate else []
        pass_rate = evaluate_pass_rate(tasks, working_traces, version_id)
        rounds_log.append({"round": round_num, "passRate": pass_rate})

        if pass_rate >= best_pass_rate:
            best_pass_rate = pass_rate
            best_mutations = mutations
            best_round = round_num

        if pass_rate >= _min_pass_rate():
            break

    return best_mutations, {
        "rounds": rounds_log,
        "bestRound": best_round,
        "baselinePassRate": baseline_pass_rate,
        "finalPassRate": best_pass_rate,
        "evalScoreDelta": best_pass_rate - baseline_pass_rate,
    }
