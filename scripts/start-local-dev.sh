#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "缺少 .env，请先复制 .env.example 并配置。" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

mkdir -p .diy-data .diy-trial logs

kill_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "停止占用 ${port} 的进程: ${pids}"
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}

for port in "${DIY_CONTROL_PLANE_PORT:-9878}" "${DIY_DATA_PLANE_PORT:-3080}" "${DIY_EVOLUTION_URL##*:}" "${DIY_MOCK_MODEL_PORT:-18999}"; do
  kill_port "$port"
done

if [[ ! -f services/control-plane/dist/index.js ]]; then
  echo "正在构建..."
  npm run build
fi

RUN="$ROOT/scripts/run-with-env.sh"
chmod +x "$RUN"

nohup "$RUN" node --import tsx scripts/mock-model.mts > logs/mock-model.log 2>&1 &
echo $! > .diy-trial/mock-model.pid

nohup "$RUN" node services/control-plane/dist/index.js > logs/control-plane.log 2>&1 &
echo $! > .diy-trial/control-plane.pid

nohup "$RUN" node services/data-plane/dist/index.js > logs/data-plane.log 2>&1 &
echo $! > .diy-trial/data-plane.pid

nohup "$RUN" bash -lc 'cd services/evolution && PYTHONPATH=. python3 server.py' > logs/evolution.log 2>&1 &
echo $! > .diy-trial/evolution.pid

wait_for() {
  local name="$1"
  local url="$2"
  for _ in $(seq 1 60); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "${name} 就绪: ${url}"
      return 0
    fi
    sleep 0.5
  done
  echo "${name} 启动超时，查看 logs/ 目录。" >&2
  return 1
}

wait_for "Mock Model" "http://127.0.0.1:${DIY_MOCK_MODEL_PORT:-18999}/health"
wait_for "Control Plane" "http://127.0.0.1:${DIY_CONTROL_PLANE_PORT:-9878}/health"
wait_for "Data Plane" "http://127.0.0.1:${DIY_DATA_PLANE_PORT:-3080}/health"
wait_for "Evolution" "http://127.0.0.1:${DIY_EVOLUTION_URL##*:}/health"

echo
echo "本地 Agent 平台已启动。"
echo "  Control Plane: ${DIY_CONTROL_PLANE_URL}"
echo "  Data Plane:    ${DIY_DATA_PLANE_URL}"
echo "  Evolution:     ${DIY_EVOLUTION_URL}"
echo
echo "下一步: node --import tsx scripts/local-trial.mts"
