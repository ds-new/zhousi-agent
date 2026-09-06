#!/usr/bin/env python3
"""Evolution Service sidecar — trace-aware GEPA-style mutations (Sprint 2a)."""
from __future__ import annotations

import json
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
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
    elif empty_outputs:
        mutations.append(
            {
                "path": "prompt/system",
                "before": "be concise",
                "after": "always provide a substantive answer even when uncertain",
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


class EvolutionHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path != "/run":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.read(length) if length else "{}")
        tier = body.get("tier", "L1")
        mutations = propose_mutations(body)
        response = {
            "runId": str(uuid.uuid4()),
            "status": "awaiting_review" if tier == "L2" else "completed",
            "candidateVersionId": f"candidate-{uuid.uuid4().hex[:8]}",
            "evalScoreDelta": 0.03 if mutations else 0.0,
            "requiresReview": tier == "L2",
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
