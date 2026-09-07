#!/usr/bin/env bash
set -euo pipefail
export DIY_CONTROL_PLANE_URL="${DIY_CONTROL_PLANE_URL:-http://127.0.0.1:9878}"
echo "Enterprise Data Plane options:"
echo "  npm run dev:data-plane          # HTTP sync surface on :3080"
echo "  dsh --profile web --patch ./cordis.enterprise.patch.yml"
echo "Control plane expected at: $DIY_CONTROL_PLANE_URL"
