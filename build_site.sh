#!/bin/bash
# Adapted from stashapp/CommunityScripts' build_site.sh (AGPLv3.0)
# https://github.com/stashapp/CommunityScripts/blob/main/LICENSE

# Builds the plugin source index Stash installs from.
# Outputs to _site (or $1):
# index.yml
# stash-tcode.zip   (the contents of plugins/stash-tcode/)

outdir="$1"
if [ -z "$outdir" ]; then
    outdir="_site"
fi

rm -rf "$outdir"
mkdir -p "$outdir"

plugin_id=stash-tcode
dir=plugins/$plugin_id
f=$dir/$plugin_id.yml

echo "Processing $plugin_id"

version=$(git log -n 1 --pretty=format:%h -- "$dir")
updated=$(TZ=UTC0 git log -n 1 --date="format-local:%F %T" --pretty=format:%ad -- "$dir")

zipfile=$(realpath "$outdir/$plugin_id.zip")
pushd "$dir" > /dev/null
zip -r "$zipfile" . > /dev/null
popd > /dev/null

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
