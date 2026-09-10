"""Evolution engine selector (heuristic | dspy | auto)."""
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


def run_evolution(body: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    mode = os.environ.get("DIY_EVOLUTION_ENGINE", "auto").lower()
    if mode == "heuristic":
        return heuristic_propose(body), "heuristic"
    if mode == "dspy" or (mode == "auto" and _dspy_available()):
        from dspy_engine import propose_mutations as dspy_propose

        return dspy_propose(body)
    return heuristic_propose(body), "heuristic"
