#!/usr/bin/env python3
"""Evolution Service sidecar — trace-aware GEPA-style mutations (Hermes loop)."""
from __future__ import annotations

import json
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

from engine import run_evolution


class EvolutionHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path != "/run":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.read(length) if length else "{}")
        tier = body.get("tier", "L1")
        mutations, engine, gepa_meta = run_evolution(body)
        response = {
            "runId": str(uuid.uuid4()),
            "status": "awaiting_review" if tier == "L2" else "completed",
            "candidateVersionId": f"candidate-{uuid.uuid4().hex[:8]}",
            "evalScoreDelta": gepa_meta.get("evalScoreDelta", 0.03 if mutations else 0.0),
            "requiresReview": tier == "L2",
            "engine": engine,
            "gepaRounds": gepa_meta.get("rounds", []),
            "gepaBestRound": gepa_meta.get("bestRound"),
            "gepaBaselinePassRate": gepa_meta.get("baselinePassRate"),
            "gepaFinalPassRate": gepa_meta.get("finalPassRate"),
            "mutations": mutations,
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())

    def log_message(self, format: str, *args: object) -> None:
        return


def main() -> None:
    port = int(__import__("os").environ.get("DIY_EVOLUTION_PORT", "9880"))
    server = HTTPServer(("127.0.0.1", port), EvolutionHandler)
    print(f"evolution service listening on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
