#!/usr/bin/env bash
# Run by the Pages workflow on the deploy copy (never committed back).
# Gives every JS/CSS file a new URL per deploy (?v=<commit>) so phones can't
# keep running a stale mix of old and new files, and fills in the build
# label shown in the footer.
#   tools/stamp-build.sh <short-sha>
set -euo pipefail
V="${1:?usage: stamp-build.sh <version>}"
STAMP="$V · $(date -u +'%Y-%m-%d %H:%M') UTC"
# './x.js' references inside the modules (imports, worklet URLs)
sed -i -E "s#'\./([A-Za-z0-9_-]+)\.js'#'./\1.js?v=$V'#g" src/*.js
# entry script + stylesheet in the page
sed -i -E "s#(src=\"src/[A-Za-z0-9_-]+\.js)\"#\1?v=$V\"#g; s#(href=\"src/[A-Za-z0-9_-]+\.css)\"#\1?v=$V\"#g" index.html
sed -i "s#__BUILD__#$STAMP#g" index.html
echo "stamped build $STAMP"
