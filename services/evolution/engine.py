"""Evolution engine selector (heuristic | dspy | auto) with GEPA multi-round loop."""
from __future__ import annotations

import os
from typing import Any

from gepa_loop import run_gepa_loop
from heuristic import propose_mutations as heuristic_propose


def _dspy_available() -> bool:
    if os.environ.get("DIY_EVOLUTION_USE_DSPY_STUB") == "1":
        return True
    try:
        import dspy  # noqa: F401

        return True
    except ImportError:
        return False


def _gepa_enabled() -> bool:
    return os.environ.get("DIY_GEPA_ENABLED", "0") != "0"


def _propose(body: dict[str, Any], mode: str) -> tuple[list[dict[str, Any]], str]:
    if mode == "heuristic":
        return heuristic_propose(body), "heuristic"
    if mode == "dspy" or (mode == "auto" and _dspy_available()):
        from dspy_engine import propose_mutations as dspy_propose

        mutations, engine = dspy_propose(body)
        return mutations, engine
    return heuristic_propose(body), "heuristic"


def run_evolution(body: dict[str, Any]) -> tuple[list[dict[str, Any]], str, dict[str, Any]]:
    mode = os.environ.get("DIY_EVOLUTION_ENGINE", "auto").lower()

    def propose(current: dict[str, Any]) -> list[dict[str, Any]]:
        mutations, _engine = _propose(current, mode)
        return mutations

    if _gepa_enabled() and body.get("evalTasks"):
        mutations, gepa_meta = run_gepa_loop(body, propose)
        _, engine = _propose(body, mode)
        return mutations, engine, gepa_meta

    mutations, engine = _propose(body, mode)
    return mutations, engine, {}
