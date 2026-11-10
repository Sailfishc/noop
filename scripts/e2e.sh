#!/bin/sh
# End-to-end: builds remi-server, starts throwaway servers and runs
# server/test/e2e-team.ts and e2e-dispatch.ts against them, with this repository's
# daemon code as the machine, then checks the app's fixtures against a real server.
# CI's `server` job runs this; so does scripts/check.sh.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
PIDS=""
cleanup() { for p in $PIDS; do kill "$p" 2>/dev/null || true; done; rm -rf "$T"; }
trap cleanup EXIT INT TERM

(cd "$ROOT/server" && go build -o "$T/remi-server" ./cmd/remi-server)
# e2e-dispatch commits in temporary repositories; a fresh machine (CI) has no git identity.
# Set it for this run only, never in the person's git config.
if ! git config user.email > /dev/null 2>&1; then
  export GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@localhost GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@localhost
fi

run() { # <name> <port> <script>
  code=$("$T/remi-server" invite -data "$T/$1" -email zhang@corp.com | tail -1 | sed 's|.*/invite/||')
  "$T/remi-server" -addr "127.0.0.1:$2" -data "$T/$1" > "$T/$1.log" 2>&1 &
  PIDS="$PIDS $!"
  i=0
  until curl -s -o /dev/null "http://127.0.0.1:$2/" 2>/dev/null || [ $i -ge 50 ]; do sleep 0.1; i=$((i + 1)); done
  bun "$ROOT/$3" "http://127.0.0.1:$2" "$code" || { echo "--- $1 server log:"; tail -30 "$T/$1.log"; return 1; }
}
PORT="${E2E_PORT:-18081}"
run team "$PORT" server/test/e2e-team.ts
run dispatch "$((PORT + 1))" server/test/e2e-dispatch.ts
# the pretend server of the app's UI tests against this one (scripts/check-contract.ts)
run contract "$((PORT + 2))" scripts/check-contract.ts
