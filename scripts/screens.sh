#!/bin/sh
# Screenshots of the client's main desktop screens (app/screens.test.tsx), taken in
# headless Chromium, into app/.nsh/screens/*.png. Needs nsh (scripts/install-nsh.sh)
# and Chrome or Chromium; NSH_BROWSER picks the browser.
set -eu
cd "$(dirname "$0")/../app"
rm -rf .nsh/screens && mkdir -p .nsh/screens
BROWSER="${NSH_BROWSER:-}"
[ -z "$BROWSER" ] && [ -x /opt/pw-browsers/chromium ] && BROWSER=/opt/pw-browsers/chromium
# Chrome refuses to run as root without --no-sandbox (cloud sessions and containers
# run as root), and nsh doesn't pass it: give it a wrapper that does.
if [ "$(id -u)" = 0 ]; then
  real="${BROWSER:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}"
  [ -n "$real" ] || { echo "screens: no Chrome or Chromium found; set NSH_BROWSER" >&2; exit 1; }
  BROWSER="$(pwd)/.nsh/chrome-no-sandbox"
  printf '#!/bin/sh\nexec "%s" --no-sandbox "$@"\n' "$real" > "$BROWSER"
  chmod +x "$BROWSER"
fi
if [ -n "$BROWSER" ]; then
  nsh test screens.test.tsx --target web --browser "$BROWSER"
else
  nsh test screens.test.tsx --target web
fi
n=$(ls .nsh/screens/*.png 2>/dev/null | wc -l)
[ "$n" -gt 0 ] || { echo "screens: no screenshots were saved" >&2; exit 1; }
echo "screens: $n screenshots in app/.nsh/screens/"
