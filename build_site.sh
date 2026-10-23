#!/bin/bash
# Adapted from stashapp/CommunityScripts' build_site.sh (AGPLv3.0)
# https://github.com/stashapp/CommunityScripts/blob/main/LICENSE

# Builds the plugin source index Stash installs from.
# Outputs to _site (or $1):
# index.yml
# stash-tcode.zip
# The zip holds plugins/stash-tcode/ plus the userscript from the repo root, which is
# the one source for both the plugin and Tampermonkey installs.

outdir="$1"
if [ -z "$outdir" ]; then
    outdir="_site"
fi

rm -rf "$outdir"
mkdir -p "$outdir"

plugin_id=stash-tcode
dir=plugins/$plugin_id
f=$dir/$plugin_id.yml
script=stash-tcode.user.js

echo "Processing $plugin_id"

version=$(git log -n 1 --pretty=format:%h -- "$dir" "$script")
updated=$(TZ=UTC0 git log -n 1 --date="format-local:%F %T" --pretty=format:%ad -- "$dir" "$script")

stage=$(mktemp -d)
cp -r "$dir"/. "$stage"
cp "$script" "$stage"

zipfile=$(realpath "$outdir/$plugin_id.zip")
pushd "$stage" > /dev/null
zip -r "$zipfile" . > /dev/null
popd > /dev/null
rm -rf "$stage"

name=$(grep "^name:" "$f" | head -n 1 | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')
description=$(grep "^description:" "$f" | head -n 1 | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')
ymlVersion=$(grep "^version:" "$f" | head -n 1 | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')

echo "- id: $plugin_id
  name: $name
  metadata:
    description: $description
  version: $ymlVersion-$version
  date: $updated
  path: $plugin_id.zip
  sha256: $(sha256sum "$zipfile" | cut -d' ' -f1)
" >> "$outdir"/index.yml
