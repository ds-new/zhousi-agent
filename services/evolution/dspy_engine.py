"""Optional DSPy-backed mutation proposer with heuristic fallback."""
from __future__ import annotations

import os
from typing import Any

from heuristic import propose_mutations as heuristic_propose


def _dspy_available() -> bool:
    if os.environ.get("DIY_EVOLUTION_USE_DSPY_STUB") == "1":
        return True
    try:
        import dspy  # noqa: F401

        return True
    except ImportError:
        return False


def propose_mutations(body: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    """Return (mutations, engine_name). Uses stub/heuristic when DSPy is unavailable."""
    if os.environ.get("DIY_EVOLUTION_USE_DSPY_STUB") == "1":
        return heuristic_propose(body), "dspy-stub"

    if not _dspy_available():
        return heuristic_propose(body), "heuristic"

    import dspy

    class MutationSignature(dspy.Signature):
        """Summarize trace failures into one actionable profile mutation hint."""

        target = dspy.InputField()
        trace_summary = dspy.InputField()
        mutation_hint = dspy.OutputField(desc="short actionable refinement")

    predictor = dspy.Predict(MutationSignature)
    traces = body.get("traces") or []
    failed_tools = [
        str(tool_call.get("name"))
        for trace in traces
        for tool_call in (trace.get("toolCalls") or [])
        if not tool_call.get("ok") and tool_call.get("name")
    ]
    trace_summary = f"failed_tools={failed_tools[:3]} empty_outputs={sum(1 for t in traces if not t.get('output'))}"
    try:
        prediction = predictor(
            target=str(body.get("target", "skill")),
            trace_summary=trace_summary,
        )
        hint = str(getattr(prediction, "mutation_hint", "") or "").strip()
    except Exception:
        hint = ""

    mutations = heuristic_propose(body)
    if hint and mutations:
        first = mutations[0]
        mutations[0] = {
            **first,
            "after": f"{first.get('after', '')}\n\nDSPy hint: {hint[:240]}",
        }
    return mutations, "dspy"
