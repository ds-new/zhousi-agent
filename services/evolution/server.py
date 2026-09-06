#!/usr/bin/env python3
"""Evolution HTTP sidecar — GEPA placeholder."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer

from diy_agent_evolution import (
    EvolutionRequest,
    GovernanceTier,
    run_evolution,
)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/run":
            self._json(404, {"error": "not_found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        tier = GovernanceTier(body.get("tier", "L1"))
        result = run_evolution(
            EvolutionRequest(
                profile_id=body["profileId"],
                base_version_id=body["baseVersionId"],
                tier=tier,
                target=body.get("target", "skill"),
            )
        )
        self._json(
            200,
            {
                "runId": result.run_id,
                "status": result.status.value,
                "candidateVersionId": result.candidate_version_id,
                "evalScoreDelta": result.eval_score_delta,
                "requiresReview": result.requires_review,
            },
        )

    def _json(self, code: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    port = int(__import__("os").environ.get("DIY_EVOLUTION_PORT", "9880"))
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"evolution sidecar listening on :{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
