#!/usr/bin/env bash
# Update the live app after changing the code. Run as your normal user (not with sudo):
#
#   ./update.sh               run the tests, build the frontend, install and restart
#   ./update.sh --skip-tests  same, without the tests (for frontend-only changes)
#
# It stops at the first problem, so a failing test or build never reaches the live app.
# It asks for your password once, for the install step. Photos and the database are never touched.
set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "$0")" && pwd)
APP_URL=https://mc-server.tailc7ae2e.ts.net
export PATH="$HOME/.local/opt/node/bin:$PATH"

run_tests=true
case "${1:-}" in
  "") ;;
  --skip-tests) run_tests=false ;;
  *) echo "Usage: ./update.sh [--skip-tests]" >&2; exit 2 ;;
esac

if [[ $EUID -eq 0 ]]; then
  echo "Run it without sudo: ./update.sh (it asks for your password when it needs it)." >&2
  exit 1
fi
command -v npm >/dev/null || { echo "npm not found in ~/.local/opt/node/bin." >&2; exit 1; }

cd "$PROJECT_DIR"
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' frontend/package.json)
echo "Updating Memories to v$version"

if $run_tests; then
  echo
  echo "==> 1/3 Tests"
  .venv/bin/python -m pytest -q
fi

echo
echo "==> 2/3 Building the frontend"
cd frontend
# Install packages on first use, or when package-lock.json changed since the last install.
if [[ ! -d node_modules || package-lock.json -nt node_modules/.package-lock.json ]]; then
  npm ci
fi
npm run build
cd ..

echo
echo "==> 3/3 Installing (your password may be needed)"
sudo deploy/install.sh

echo
if curl -fsS --max-time 10 "$APP_URL/api/health" >/dev/null 2>&1; then
  echo "Done: v$version is live at $APP_URL"
else
  echo "Installed, but $APP_URL didn't answer. Check: tailscale serve status" >&2
  exit 1
fi
