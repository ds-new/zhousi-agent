"""Trace-heuristic mutation proposer (default evolution engine)."""
from __future__ import annotations

from typing import Any


def analyze_traces(traces: list[dict[str, Any]]) -> tuple[list[str], int]:
    failed_tools: list[str] = []
    empty_outputs = 0
    for trace in traces:
        if not trace.get("output"):
            empty_outputs += 1
        for tool_call in trace.get("toolCalls") or []:
            if not tool_call.get("ok"):
                name = tool_call.get("name")
                if name:
                    failed_tools.append(str(name))
    return failed_tools, empty_outputs


def snapshot_system_prompt(body: dict[str, Any]) -> str:
    snapshot = body.get("snapshot") or {}
    if isinstance(snapshot, dict):
        prompt = snapshot.get("systemPrompt")
        if isinstance(prompt, str) and prompt:
            return prompt
    return "be concise"


def propose_mutations(body: dict[str, Any]) -> list[dict[str, Any]]:
    target = body.get("target", "skill")
    tier = body.get("tier", "L1")
    traces = body.get("traces") or []
    failed_tools, empty_outputs = analyze_traces(traces)
    mutations: list[dict[str, Any]] = []

    if target not in ("skill", "mcp_description", "prompt"):
        target = "skill"

    if target == "mcp_description" and failed_tools:
        tool = failed_tools[0]
        mutations.append(
            {
                "path": f"mcp/{tool}/description",
                "before": "generic tool description",
                "after": f"Clarify required parameters and error handling for {tool}",
                "tier": tier,
            }
        )
    elif target == "skill" and failed_tools:
        tool = failed_tools[0]
        mutations.append(
            {
                "path": f"skills/{tool}",
                "before": "call tool directly",
                "after": f"validate inputs and retry policy for {tool}",
                "tier": tier,
            }
        )
    elif target == "prompt" or empty_outputs:
        before = snapshot_system_prompt(body)
        mutations.append(
            {
                "path": "prompt/system",
                "before": before,
                "after": f"{before}\n\nAlways provide a substantive answer even when uncertain.",
                "tier": tier,
            }
        )
    else:
        eval_tasks = body.get("evalTasks") or []
        hint = eval_tasks[0].get("input", "baseline") if eval_tasks else "baseline"
        mutations.append(
            {
                "path": "skills/0",
                "before": str(hint)[:80],
                "after": f"gepa-refined: {str(hint)[:60]}",
                "tier": tier,
            }
        )

    return mutations
