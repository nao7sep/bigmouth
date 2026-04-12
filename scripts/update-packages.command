#!/usr/bin/env bash
set -euo pipefail

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
    echo "bigmouth update-packages failed with exit code $status."
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

trap 'pause_on_failure $?' EXIT

require_command node
require_command npm
require_command lsof

cd "$REPO_DIR"

log_step "Stopping stale BigMouth listeners"
stop_port 3141
stop_port 5173

log_step "Installing root dependencies"
npm install

log_step "Updating root packages"
npm update

log_step "Installing server dependencies"
npm install --prefix "$REPO_DIR/server"

log_step "Updating server packages"
npm update --prefix "$REPO_DIR/server"

log_step "Installing client dependencies"
npm install --prefix "$REPO_DIR/client"

log_step "Updating client packages"
npm update --prefix "$REPO_DIR/client"

log_step "Cleaning previous build outputs"
rm -rf "$REPO_DIR/server/dist" "$REPO_DIR/client/dist"

log_step "Building server and client"
npm run build
