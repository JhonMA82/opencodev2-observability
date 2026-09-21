#!/bin/bash

set -e

if [[ "$OSTYPE" == "darwin"* ]]; then
    CONFIG_DIR="$HOME/Library/Application Support/opencode"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
else
    CONFIG_DIR="$HOME/.config/opencode"
fi

DEST="$CONFIG_DIR/plugins/opencode-observability"

if [ ! -e "$DEST" ]; then
    echo "OpenCode observability plugin is not installed at:"
    echo "  $DEST"
    exit 0
fi

echo "Removing OpenCode observability plugin:"
echo "  $DEST"
rm -rf -- "$DEST"
echo "Removed. Restart OpenCode to unload the plugin from running sessions."
