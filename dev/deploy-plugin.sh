#!/bin/bash
# Copies the plugin into a local Stash for testing. Then in Stash: Settings -> Plugins ->
# Reload plugins, and refresh the page.
#
# Usage: STASH_PLUGINS_DIR=/path/to/stash/plugins dev/deploy-plugin.sh
# (or put STASH_PLUGINS_DIR=... in a .env file at the repo root)

cd "$(dirname "$0")/.." || exit 1
if [ -z "$STASH_PLUGINS_DIR" ] && [ -f .env ]; then
    STASH_PLUGINS_DIR=$(grep '^STASH_PLUGINS_DIR=' .env | cut -d= -f2- | sed 's/\r//')
fi
if [ -z "$STASH_PLUGINS_DIR" ]; then
    echo "Set STASH_PLUGINS_DIR to your Stash plugins folder" >&2
    exit 1
fi

dest="$STASH_PLUGINS_DIR/stash-tcode"
mkdir -p "$dest"
cp plugins/stash-tcode/* "$dest"/
echo "Copied to $dest"
