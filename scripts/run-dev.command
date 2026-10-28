#!/usr/bin/env bash
set -euo pipefail

# run-dev: run the app from source with live reload, in its loosest configuration.
# For active coding and debugging. The strict, production-faithful launchers are
# run-built (launch the existing packaged app bundle without rebuilding) and
# rebuild (build and package a fresh bundle, then launch).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="BigMouth"
RUNTIME_HELPER="$SCRIPT_DIR/launcher-runtime.mjs"
APP_PID=""
# The renderer dev server's fixed endpoint. The electron-vite config owns it;
# a test keeps this copy equal to it.
RENDERER_HOST="127.0.0.1"
RENDERER_PORT="26263"
RENDERER_URL="http://$RENDERER_HOST:$RENDERER_PORT"

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
  if [[ "$status" -ne 0 && ( "$status" -lt 128 || "$status" -gt 143 ) ]]; then
    echo
    echo "bigmouth run-dev failed with exit code $status."
    read -r -p "Press Enter to close..."
  fi
}

cleanup() {
  local status="$?"
  trap - EXIT
  # Closing this launcher closes the app it started, unless a later launcher has replaced it.
  if [[ -n "$APP_PID" ]]; then
    node "$RUNTIME_HELPER" stop-if-recorded "$APP_PID" "$APP_NAME" >/dev/null 2>&1 || true
  fi
  pause_on_failure "$status"
  exit "$status"
}

trap cleanup EXIT

require_command node
require_command npm

cd "$REPO_DIR"

log_step "Replacing any existing $APP_NAME runtime"
node "$RUNTIME_HELPER" stop "$APP_NAME"
node "$RUNTIME_HELPER" check-endpoint "$RENDERER_HOST" "$RENDERER_PORT"

log_step "Installing dependencies"
npm install --no-audit --no-fund

# Electron's package has no install script: it downloads its binary the first
# time something requires it, and electron-vite only reads the path that download
# records. Its installer returns at once when the binary is already there.
log_step "Ensuring the Electron binary"
node node_modules/electron/install.js

log_step "Starting $APP_NAME in development mode"
npm run dev &
DEV_PID=$!
node "$RUNTIME_HELPER" wait-http "$RENDERER_URL" 60000
APP_PID="$(node "$RUNTIME_HELPER" record-wrapped "$DEV_PID" "$REPO_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$APP_NAME")"
log_step "$APP_NAME is ready at $RENDERER_URL"
wait "$DEV_PID"
