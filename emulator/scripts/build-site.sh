#!/bin/sh
# Build the static browser emulator into dist/ (index.html, app, emulator core, ROM, xterm.js).
set -eu
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist/emu dist/vendor
cp site/index.html site/app.js site/style.css site/.htaccess dist/
cp site/vendor/* dist/vendor/
cp emu/board.js emu/cpu8051.js emu/ihex.js emu/sdcard.js emu/fatfmt.js dist/emu/
cp firmware/build/dos51.ihx dist/
echo "built dist/ from $(git rev-parse --short HEAD)$(git diff --quiet || echo '+dirty')"

# Cache-bust: the server caches .js/.css for days, so stamp every same-origin
# reference with a content hash; a redeploy then always loads matching files.
V=$(cd dist && find . -type f ! -name .htaccess | sort | xargs cat | shasum -a 256 | cut -c1-10)
sed -i '' -E "s#(href|src)=\"((vendor/)?[a-z0-9.-]+\.(css|js))\"#\1=\"\2?v=$V\"#g" dist/index.html
sed -i '' -E "s#from '(\./[a-z0-9/.-]+\.js)'#from '\1?v=$V'#; s#fetch\('dos51\.ihx'\)#fetch('dos51.ihx?v=$V')#" dist/app.js dist/emu/*.js
echo "cache-bust v=$V"
