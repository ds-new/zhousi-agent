#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export DIY_CONTROL_PLANE_URL="${DIY_CONTROL_PLANE_URL:-http://127.0.0.1:9878}"
export DIY_EVOLUTION_URL="${DIY_EVOLUTION_URL:-http://127.0.0.1:9880}"

echo "==> Control Plane (:9878)"
node "$ROOT/services/control-plane/dist/index.js" &
CP_PID=$!

echo "==> Evolution sidecar (:9880)"
(cd "$ROOT/services/evolution" && PYTHONPATH=. python3 server.py) &
EV_PID=$!

cleanup() {
  kill "$CP_PID" "$EV_PID" 2>/dev/null || true
}
trap cleanup EXIT

sleep 1
echo "==> DSH headless (requires: npm i -g @deepseek-ai/deepseek-harness)"
if command -v dsh >/dev/null 2>&1; then
  dsh --profile headless --patch "$ROOT/cordis.headless.patch.yml"
else
  echo "dsh not installed — skip runtime. Install: npm i -g @deepseek-ai/deepseek-harness"
  wait
fi
