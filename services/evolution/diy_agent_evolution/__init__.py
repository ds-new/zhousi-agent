"""Evolution Service — GEPA/DSPy sidecar for L1/L2 profile evolution."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class GovernanceTier(str, Enum):
    L0 = "L0"
    L1 = "L1"
    L2 = "L2"
    L3 = "L3"


class EvolutionStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    AWAITING_REVIEW = "awaiting_review"


@dataclass
class EvolutionRequest:
    profile_id: str
    base_version_id: str
    tier: GovernanceTier
    eval_tasks: list[dict[str, Any]] = field(default_factory=list)
    target: str = "skill"  # skill | prompt | mcp_description


@dataclass
class EvolutionResult:
    run_id: str
    status: EvolutionStatus
    candidate_version_id: str | None = None
    eval_score_delta: float | None = None
    requires_review: bool = False


def can_auto_promote(tier: GovernanceTier) -> bool:
    """L0/L1 auto-promote on eval pass; L2+ requires human review."""
    return tier in (GovernanceTier.L0, GovernanceTier.L1)


def run_evolution(req: EvolutionRequest) -> EvolutionResult:
    """
    Placeholder for GEPA integration.
    Production: call gepa.optimize_anything with trace-based evaluator.
    """
    if req.tier == GovernanceTier.L3:
        return EvolutionResult(
            run_id="blocked",
            status=EvolutionStatus.FAILED,
        )

    requires_review = not can_auto_promote(req.tier)
    return EvolutionResult(
        run_id="run-placeholder",
        status=(
            EvolutionStatus.AWAITING_REVIEW
            if requires_review
            else EvolutionStatus.COMPLETED
        ),
        candidate_version_id="candidate-v1",
        eval_score_delta=0.05,
        requires_review=requires_review,
    )


if __name__ == "__main__":
    result = run_evolution(
        EvolutionRequest(
            profile_id="p1",
            base_version_id="v1",
            tier=GovernanceTier.L2,
        )
    )
    print(result)
