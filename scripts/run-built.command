#!/usr/bin/env bash
set -euo pipefail

# run-built: launch the EXISTING production build of bigmouth without
# rebuilding, so it starts instantly. This is the daily-use launcher and the
# one that surfaces production-only failures (strict CSP, same-origin serving).
# It never installs or builds — if you changed source, run rebuild first. The
# production server serves the built client from the same port (:3141), so the
# browser opens at the SERVER port.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log_step() {
  printf '\n==> %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

pause_on_failure() {
  local status="$1"
  if [[ "$status" -ne 0 && "$status" -ne 130 ]]; then
    echo
    echo "bigmouth run-built failed with exit code $status."
    read -r -p "Press Enter to close..."
  fi
}

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping processes on port $port: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

open_browser_when_ready() {
  (
    for _ in {1..60}; do
      if curl -fsS "http://127.0.0.1:3141/api/health" >/dev/null 2>&1; then
        open "http://localhost:3141" >/dev/null 2>&1 || true
        exit 0
      fi
      sleep 1
    done
  ) &
}

trap 'pause_on_failure $?' EXIT

require_command node
require_command npm
require_command lsof
require_command curl

cd "$REPO_DIR"

# No build, no dependency install here: this launcher must start instantly. If
# there is no usable build yet, stop and point at rebuild rather than launching
# something stale or empty.
if [[ ! -f client/dist/index.html || ! -f server/dist/index.js ]]; then
  echo "No production build found — run rebuild first."
  exit 1
fi

built_at="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S %Z' client/dist/index.html 2>/dev/null || echo 'unknown')"
log_step "Launching the existing production build (built: $built_at)"
echo "If you changed source since then, run rebuild instead."

log_step "Stopping stale BigMouth listeners"
stop_port 3141

log_step "Waiting to open the browser when the production server responds"
open_browser_when_ready

# The production server serves the built client from the same origin on :3141.
# NODE_ENV=production enables production behavior. The root has no `start`
# script, so the server's own start script is invoked via the prefix form.
log_step "Starting the production server (NODE_ENV=production)"
NODE_ENV=production npm --prefix server run start
