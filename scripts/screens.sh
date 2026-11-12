#!/bin/sh
# Screenshots of the client's main screens (app/screens.test.tsx), taken in headless Chromium, into
# app/.nsh/screens/*.png. Needs nsh (scripts/install-nsh.sh) and Chrome or Chromium; NSH_BROWSER picks the browser,
# SCREENS_FILTER runs only the tests whose name contains it.
#
# The browser runs through a wrapper that
#   - passes --no-sandbox when run as root (cloud sessions and containers; Chrome refuses otherwise, nsh doesn't pass it);
#   - plays a phone's touch screen: nsh launches the browser as a mouse (its own --blink-settings), and NSH's web
#     runtime takes the idiom from the pointer, so phone screens would draw in the desktop (pointer) density. The
#     wrapper swaps that setting for a coarse pointer that doesn't hover, on a 390-point screen. The desktop screens
#     ask for a desktop platform in screens.test.tsx and keep the pointer density.
set -eu
cd "$(dirname "$0")/../app"
rm -rf .nsh/screens && mkdir -p .nsh/screens
BROWSER="${NSH_BROWSER:-}"
[ -z "$BROWSER" ] && [ -x /opt/pw-browsers/chromium ] && BROWSER=/opt/pw-browsers/chromium
real="${BROWSER:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}"
[ -n "$real" ] || { echo "screens: no Chrome or Chromium found; set NSH_BROWSER" >&2; exit 1; }
nosandbox=""
[ "$(id -u)" = 0 ] && nosandbox="--no-sandbox"
touch_settings="--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1"
wrapper="$(pwd)/.nsh/chrome-touch"
{
  echo '#!/bin/sh'
  echo 'for a in "$@"; do'
  echo '  shift'
  echo '  case "$a" in'
  echo "    --blink-settings=*) set -- \"\$@\" $touch_settings ;;"
  echo '    *) set -- "$@" "$a" ;;'
  echo '  esac'
  echo 'done'
  echo "exec \"$real\" $nosandbox --window-size=390,844 \"\$@\""
} > "$wrapper"
chmod +x "$wrapper"
if [ -n "${SCREENS_FILTER:-}" ]; then
  nsh test screens.test.tsx --target web --browser "$wrapper" --filter "$SCREENS_FILTER"
else
  nsh test screens.test.tsx --target web --browser "$wrapper"
fi
n=$(ls .nsh/screens/*.png 2>/dev/null | wc -l)
[ "$n" -gt 0 ] || { echo "screens: no screenshots were saved" >&2; exit 1; }
echo "screens: $n screenshots in app/.nsh/screens/"
