#!/bin/sh
# Builds the web package remi-server serves (-static app/dist/web/noop), then adds what
# `nsh package` has no place for: the push service worker at the site's root (its scope is the
# whole app), a stable icon URL for notifications, and the manifest's colors (the gallery's page).
set -e
cd "$(dirname "$0")"
NSH="${NSH:-$HOME/work/nsh/target/debug/nsh}"
# The package directory is named after the display name (Remi); the server is pointed at dist/web/noop.
OUT="dist/web/noop"
TMP="dist/.web-build"
rm -rf "$TMP"
"$NSH" package --target web -o "$TMP" "$@"
rm -rf "$OUT" dist/web/.release
mkdir -p dist/web
mv "$TMP"/* "$OUT"
rmdir "$TMP"
cp web/sw.js "$OUT/sw.js"
cp "$OUT"/icons/192.*.png "$OUT/icons/192.png"
# -i.bak works with both GNU and BSD (macOS) sed
sed -i.bak 's/"background_color": "[^"]*"/"background_color": "#f7f7f4"/; s/"theme_color": "[^"]*"/"theme_color": "#f7f7f4"/' "$OUT/manifest.webmanifest"
rm -f "$OUT/manifest.webmanifest.bak"
echo "✓ added sw.js, icons/192.png, manifest colors"
