#!/usr/bin/env bash
# A whole Remi on this computer, to try a change end to end: remi-server (with the web client when nsh is
# here), a small seeded team, and this repository's daemon as their machine, with scripts/fake-codex.ts
# standing in for Codex (no model, no keys). Everything lives in .dev/ (git-ignored).
#
#   scripts/dev.sh            start (seeds the team on first run), Ctrl-C stops
#   scripts/dev.sh --fresh    throw the old team away first
#   DEV_PORT=9090 scripts/dev.sh
#
# It prints login links for the two people (open them in a browser, or the desktop app's 登录码),
# and a curl line for the API. Agents: run it in the background and drive it with curl or Playwright.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/.dev"
PORT="${DEV_PORT:-8080}"
URL="http://127.0.0.1:$PORT"
[ "${1:-}" = "--fresh" ] && rm -rf "$DIR"
mkdir -p "$DIR"

(cd "$ROOT/server" && go build -o "$DIR/remi-server" ./cmd/remi-server)
STATIC=()
if command -v nsh > /dev/null; then
  echo "dev: building the web client (about 20 s)"
  (cd "$ROOT/app" && NSH="$(command -v nsh)" ./build-web.sh > "$DIR/build-web.log" 2>&1) \
    && STATIC=(-static "$ROOT/app/dist/web/noop") \
    || echo "dev: web client build failed ($DIR/build-web.log); API only"
else
  echo "dev: no nsh, so no web client (scripts/install-nsh.sh); API only"
fi

INVITE=""
if [ ! -f "$DIR/state.json" ]; then
  rm -rf "$DIR/data" "$DIR/repo" "$DIR/origin.git" "$DIR/machine" "$DIR/work"
  INVITE=$("$DIR/remi-server" invite -data "$DIR/data" -email zw@dev.local -role admin | tail -1 | sed 's|.*/invite/||')
fi

if curl -s -o /dev/null "$URL/"; then echo "dev: something already answers on $URL (an earlier dev.sh?); stop it or set DEV_PORT" >&2; exit 1; fi
"$DIR/remi-server" -addr "127.0.0.1:$PORT" -data "$DIR/data" -public-url "$URL" "${STATIC[@]}" > "$DIR/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT INT TERM
for _ in $(seq 50); do curl -s -o /dev/null "$URL/" && break; sleep 0.1; done
echo "dev: server on $URL (log: .dev/server.log)"

# fake-codex as this machine's `codex`; the machine's own home (repos it clones, its config) stays in .dev too
mkdir -p "$DIR/bin"
printf '#!/bin/sh\nexec bun "%s" "$@"\n' "$ROOT/scripts/fake-codex.ts" > "$DIR/bin/codex"
chmod +x "$DIR/bin/codex"
PATH="$DIR/bin:$PATH" NOOP_HOME="$DIR/machine" bun "$ROOT/scripts/dev.ts" "$URL" "$DIR" $INVITE
