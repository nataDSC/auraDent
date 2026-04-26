#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-8787}"

cd /app
npm run start --workspace @auradent/gateway &
gateway_pid=$!

cleanup() {
  if kill -0 "$gateway_pid" >/dev/null 2>&1; then
    kill "$gateway_pid"
    wait "$gateway_pid" || true
  fi
}

trap cleanup EXIT INT TERM

nginx -g 'daemon off;'
