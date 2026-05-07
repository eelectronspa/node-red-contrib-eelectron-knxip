#!/usr/bin/env bash
# Build, pack, and reinstall this package in a local Node-RED user dir.
#
# Usage:
#   scripts/install-local.sh                # uses ~/.node-red
#   NODE_RED_DIR=/path/to/userdir scripts/install-local.sh
#
# What it does:
#   1. cd to the project root (regardless of where the script is invoked from)
#   2. npm run build              (TS → dist/, copy HTML/SVG)
#   3. npm pack                   (writes node-red-contrib-eelectron-knxip-<v>.tgz)
#   4. copy the .tgz into <NODE_RED_DIR>/nodes/
#   5. npm uninstall + npm install in <NODE_RED_DIR>
#
# After this finishes, restart Node-RED for the new code to load.

set -euo pipefail

# Project root = directory containing this script's parent (../).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_RED_DIR="${NODE_RED_DIR:-$HOME/.node-red}"
NODES_SUBDIR="$NODE_RED_DIR/nodes"

cd "$PROJECT_DIR"

# Read current version + name straight from package.json so this script always
# matches whatever's checked out. No jq dependency — node + JSON.parse is
# always available because the project requires Node anyway.
PKG_NAME="$(node -p "require('./package.json').name")"
PKG_VERSION="$(node -p "require('./package.json').version")"
TGZ="${PKG_NAME}-${PKG_VERSION}.tgz"

echo "==> Project: $PKG_NAME @ $PKG_VERSION"
echo "==> Target  : $NODE_RED_DIR"
echo

echo "==> Building (npm run build)"
npm run build

echo
echo "==> Packing tarball"
npm pack >/dev/null
if [ ! -f "$PROJECT_DIR/$TGZ" ]; then
    echo "ERROR: expected $TGZ to be created by npm pack but it wasn't."
    echo "       Has the version changed since the last build? Re-run npm run build."
    exit 1
fi
echo "    $TGZ"

echo
echo "==> Copying tarball to $NODES_SUBDIR/"
mkdir -p "$NODES_SUBDIR"
cp "$PROJECT_DIR/$TGZ" "$NODES_SUBDIR/"

echo
echo "==> Reinstalling in $NODE_RED_DIR"
cd "$NODE_RED_DIR"
# Uninstall is best-effort — first run on a fresh user dir won't have it yet.
npm uninstall "$PKG_NAME" --no-audit --no-fund 2>/dev/null || true
npm install "./nodes/$TGZ" --no-audit --no-fund

echo
echo "==> Verifying"
INSTALLED="$(node -p "require('$PKG_NAME/package.json').version" 2>/dev/null || echo '?')"
echo "    installed version: $INSTALLED"

echo
if pgrep -af "node-red" >/dev/null 2>&1; then
    echo "Node-RED appears to be running. Restart it to pick up the new build:"
    echo "    pkill -f node-red ; sleep 1 ; node-red"
else
    echo "Node-RED not running. Start it with:"
    echo "    node-red"
fi
