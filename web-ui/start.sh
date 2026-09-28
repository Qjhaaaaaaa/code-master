#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB_UI_DIR="$ROOT_DIR/web-ui"
PORT="${WEB_UI_PORT:-3000}"

cd "$WEB_UI_DIR"

echo ""
echo "  Starting Claude Code Web UI..."
echo "  Port: $PORT"
echo ""

exec bun run server.ts
