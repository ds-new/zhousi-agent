#!/usr/bin/env bash
set -euo pipefail
for port in 9878 3080 9880 18999; do
  pids=$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "停止端口 ${port}: ${pids}"
    kill $pids 2>/dev/null || true
  fi
done
echo "本地服务已停止。"
