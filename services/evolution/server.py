#!/usr/bin/env python3
"""Evolution Service sidecar — trace-aware GEPA-style mutations (Hermes loop)."""
from __future__ import annotations

import json
import os
import hmac
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

from engine import run_evolution


class EvolutionHandler(BaseHTTPRequestHandler):
    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(10)

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def do_POST(self) -> None:
        if self.path != "/run":
            self.send_error(404)
            return
        token = os.environ.get("DIY_EVOLUTION_INTERNAL_TOKEN")
        if token and not hmac.compare_digest(self.headers.get("Authorization", "").encode(), f"Bearer {token}".encode()):
            self.send_error(401)
            return
        try:
            if self.headers.get("Transfer-Encoding"):
                self.send_error(400)
                return
            length = int(self.headers.get("Content-Length", 0))
            if length < 0 or length > 2 * 1024 * 1024:
                self.send_error(413)
                return
            body = json.loads(self.rfile.read(length) if length else "{}")
            tier = body.get("tier", "L1")
            if tier not in ("L0", "L1", "L2"):
                self.send_error(400)
                return
            mutations, engine, gepa_meta = run_evolution(body)
        except (ValueError, TypeError, AttributeError):
            self.send_error(400)
            return
        except Exception:
            self.send_error(503, "evolution_engine_unavailable")
            return
        response = {
            "runId": str(uuid.uuid4()),
            "status": "awaiting_review" if tier == "L2" else "completed",
            "candidateVersionId": f"candidate-{uuid.uuid4().hex[:8]}",
            "evalScoreDelta": gepa_meta.get("evalScoreDelta", 0.0),
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
    if os.environ.get("DIY_ALLOW_INSECURE_DEV") != "true" and len(os.environ.get("DIY_EVOLUTION_INTERNAL_TOKEN", "")) < 32:
        raise RuntimeError("evolution_auth_not_configured")
    port = int(__import__("os").environ.get("DIY_EVOLUTION_PORT", "9880"))
    server = HTTPServer((os.environ.get("DIY_BIND_HOST", "127.0.0.1"), port), EvolutionHandler)
    print(f"evolution service listening on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
