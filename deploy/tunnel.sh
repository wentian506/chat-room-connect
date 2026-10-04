#!/usr/bin/env bash
# Publish your local Connect server on a public https:// URL — no hosting account,
# no port forwarding, no firewall changes. Works because cloudflared dials OUT.
#
#   ./deploy/tunnel.sh
#
# Requires cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
# Note: the free quick-tunnel URL is random and changes each run, and the room only
# lives as long as this script (and your machine) keeps running.
set -euo pipefail

PORT="${PORT:-3000}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Install it first:" >&2
  echo "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
  exit 1
fi

echo "→ starting Connect on 0.0.0.0:${PORT}"
PORT="$PORT" node server.js &
SERVER_PID=$!
trap 'echo "→ stopping server"; kill "$SERVER_PID" 2>/dev/null || true' EXIT

sleep 1
echo "→ opening public tunnel (look for the trycloudflare.com URL below)"
# no `exec` here: keeping cloudflared as a child means Ctrl-C runs the trap above
cloudflared tunnel --url "http://127.0.0.1:${PORT}"
