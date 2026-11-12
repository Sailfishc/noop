#!/usr/bin/env bash
# Runs the checks CI runs, for the parts of the repository a change touches, and
# prints one summary. Meant for people and agents before they push.
#
#   scripts/check.sh              the parts changed since origin/main (committed or not)
#   scripts/check.sh all          everything
#   scripts/check.sh app server   just these parts
#
# Parts: secrets, daemon (src/, test/), server (server/), e2e (server + daemon
# together, and the app's fixtures against a real server), app (app/: nsh check,
# nsh test, layout, ui rules), screens (app/ screenshots).
# Each step's output goes to a log; a failing step prints its last lines.
# Exit status: 1 if a step failed. Steps that could not run (no nsh, no browser)
# are listed as NOT RUN: say so in the PR.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOGS="$(mktemp -d "${TMPDIR:-/tmp}/remi-check.XXXXXX")"

# --- which parts -------------------------------------------------------------
want=()
if [ $# -gt 0 ]; then
  if [ "$1" = all ]; then want=(secrets daemon server e2e app screens); else want=("$@"); fi
else
  base="$(git merge-base HEAD origin/main 2>/dev/null || true)"
  if [ -z "$base" ]; then
    echo "check: no origin/main to compare with (git fetch origin main); checking everything"
    want=(secrets daemon server e2e app screens)
  else
    changed="$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)"
    has() { grep -qE "$1" <<<"$changed"; }
    want=(secrets)
    has '^(src/|test/|package\.json|bun\.lock|tsconfig\.json)' && want+=(daemon e2e)
    has '^server/' && want+=(server e2e)
    has '^(app/|scripts/(check-layout|check-ui|ui-baseline|hit-baseline|gen-tokens|screens|install-nsh)|\.claude/skills/nsh/)' && want+=(app screens)
    has '^(app/|scripts/check-contract)' && want+=(e2e) # the app's fixtures against a real server
    has '^(\.github/|scripts/(check|e2e)\.sh)' && want=(secrets daemon server e2e app screens)
    echo "check: changed since origin/main: $(wc -l <<<"$changed" | tr -d ' ') files"
  fi
fi
# keep the order fixed and drop repeats
parts=()
for p in secrets daemon server e2e app screens; do
  for w in "${want[@]}"; do [ "$w" = "$p" ] && { parts+=("$p"); break; }; done
done
for w in "${want[@]}"; do
  case " secrets daemon server e2e app screens " in *" $w "*) ;; *) echo "check: unknown part '$w'" >&2; exit 2 ;; esac
done
echo "check: ${parts[*]}"

# --- tools -------------------------------------------------------------------
[ -d node_modules ] || bun install --frozen-lockfile > "$LOGS/bun-install.log" 2>&1
need_nsh=0
for p in "${parts[@]}"; do [ "$p" = app ] || [ "$p" = screens ] && need_nsh=1; done
if [ $need_nsh = 1 ] && ! command -v nsh > /dev/null; then
  # The SessionStart hook installs it, but only when the session starts inside this repository.
  if [ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] && dir="$(scripts/install-nsh.sh 2> "$LOGS/install-nsh.log")"; then
    export PATH="$dir:$PATH"
    echo "check: installed nsh into $dir (add it to PATH for later commands)"
  fi
fi

# --- steps -------------------------------------------------------------------
results=()
fail=0
step() { # <name> <command...>
  local name="$1"; shift
  local log="$LOGS/${name//[^a-zA-Z0-9]/_}.log" t0=$SECONDS
  printf '  %-22s ' "$name"
  if "$@" > "$log" 2>&1; then
    echo "ok ($((SECONDS - t0))s)"; results+=("ok       $name")
  else
    echo "FAILED ($((SECONDS - t0))s), log: $log"; results+=("FAILED   $name")
    fail=1
    tail -40 "$log" | sed 's/^/      | /'
  fi
}
skip() { printf '  %-22s NOT RUN: %s\n' "$1" "$2"; results+=("NOT RUN  $1: $2"); }

layout() {
  (cd app && nsh test screens.test.tsx --trace) > "$LOGS/layout-trace.txt" 2>&1 || { tail -50 "$LOGS/layout-trace.txt"; return 1; }
  bun scripts/check-layout.ts "$LOGS/layout-trace.txt"
}

for p in "${parts[@]}"; do
  case $p in
    secrets) step "secrets" bun scripts/check-secrets.ts ;;
    daemon)
      step "daemon: tsc" bunx tsc --noEmit
      step "daemon: bun test" bun test ;;
    server)
      step "server: gofmt" bash -c 'cd server && out=$(gofmt -l .) && [ -z "$out" ] || { echo "not gofmt-ed (run gofmt -w):"; echo "$out"; exit 1; }'
      step "server: go vet" bash -c 'cd server && go vet ./...'
      step "server: go test" bash -c 'cd server && go test -race ./...' ;;
    e2e) step "e2e" scripts/e2e.sh ;;
    app)
      # One token source, generated files untouched, contrast met; app/ui without raw values, pages keep their look
      # in app/ui, no unused tokens (AGENTS.md, "Client components"); both need only bun.
      step "app: design tokens" bun scripts/gen-tokens.ts --check
      step "app: ui rules" bun scripts/check-ui.ts
      if command -v nsh > /dev/null; then
        step "app: nsh check" nsh check app
        step "app: nsh test" bash -c 'cd app && nsh test'
        step "app: layout" layout
      else
        skip "app" "no nsh (scripts/install-nsh.sh, or build it as README says)"
      fi ;;
    screens)
      if command -v nsh > /dev/null; then
        step "screens" scripts/screens.sh
        results+=("         look at app/.nsh/screens/*.png for the screens you changed")
      else
        skip "screens" "no nsh"
      fi ;;
  esac
done

echo
echo "check: summary (logs in $LOGS)"
printf '  %s\n' "${results[@]}"
exit $fail
