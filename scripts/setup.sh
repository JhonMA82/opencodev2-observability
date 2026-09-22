#!/bin/bash
#
# Install the OpenCode V2 observability plugin globally.
#
# Single canonical source: plugins/opencode-observability/ in this repo.
# This script copies that source (no embedded duplicate) into the OpenCode V2
# global plugin discovery directory and installs its dependencies
# (@opencode/plugin is a runtime dependency: src/index.ts imports it, so it
# must stay in "dependencies", never in "devDependencies", or the OpenCode
# server fails with "Cannot find package '@opencode/plugin'").
#
# Idempotent: re-running it restores the installed copy to the repo state.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/plugins/opencode-observability"

if [[ "$OSTYPE" == "darwin"* ]]; then
    CONFIG_DIR="$HOME/Library/Application Support/opencode"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
else
    CONFIG_DIR="$HOME/.config/opencode"
fi

DEST="$CONFIG_DIR/plugins/opencode-observability"

echo "OpenCode V2 observability plugin setup (OpenCode >= 2.0.4 < 3 only)"
echo ""

if [ ! -f "$SRC/package.json" ] || [ ! -f "$SRC/src/index.ts" ]; then
    echo "ERROR: canonical plugin source not found at $SRC" >&2
    exit 1
fi

if ! command -v bun &> /dev/null; then
    echo "ERROR: bun is required but not installed (https://bun.sh)" >&2
    exit 1
fi

echo "Copying canonical source:"
echo "  from: $SRC"
echo "  to:   $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
# Install dependencies FIRST (package.json + tsconfig only), then copy the
# watched sources (index.ts + src). The OpenCode server caches a failed plugin
# evaluation until a watched file's content changes, so the final source writes
# must land with node_modules already complete; otherwise the first reload
# fails and stays failed until the next content change or service restart.
cp "$SRC/package.json" "$SRC/tsconfig.json" "$DEST/"

echo ""
echo "Installing plugin dependencies (@opencode/plugin runtime dependency)..."
(cd "$DEST" && bun install)

echo ""
echo "Copying watched sources (after dependencies are complete)..."
cp "$SRC/index.ts" "$DEST/"
cp -r "$SRC/src" "$DEST/src"

echo ""
echo "Typechecking installed copy..."
(cd "$DEST" && bun x tsc --noEmit)
echo "Typecheck OK."

echo ""
echo "Installed files:"
find "$DEST" -maxdepth 2 -not -path "*/node_modules*" | sort

echo ""
if command -v opencode &> /dev/null; then
    echo "Plugins known to OpenCode:"
    opencode plugin list || true
else
    echo "NOTE: 'opencode' not on PATH; skipping 'opencode plugin list'."
fi

echo ""
echo "Done. Next steps:"
echo "  1. Start the observability server:"
echo "       ./scripts/start-system.sh"
echo "  2. Restart any running OpenCode sessions so the plugin loads."
echo "  3. Verify ingestion:"
echo "       curl http://localhost:4000/health"
echo "       curl http://localhost:4000/events/recent?limit=5"
echo "  4. Open the dashboard: http://localhost:5173"
echo ""
echo "Optional: OPENCODE_OBSERVABILITY_URL=http://localhost:4000 (default)"
echo "          OPENCODE_OBSERVABILITY_DEBUG=1 for bounded plugin diagnostics"
