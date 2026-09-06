#!/usr/bin/env bash
set -euo pipefail
export DIY_CONTROL_PLANE_URL="${DIY_CONTROL_PLANE_URL:-http://127.0.0.1:9878}"
echo "Start DSH data plane with overlay:"
echo "  dsh --profile web --patch ./cordis.patch.yml"
echo "Control plane expected at: $DIY_CONTROL_PLANE_URL"
