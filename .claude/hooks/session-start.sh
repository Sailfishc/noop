#!/bin/bash
# Claude Code cloud sessions: install the pinned NSH CLI so client code can be
# type-checked (`nsh check app`), tested (`cd app && nsh test`) and screenshotted
# (scripts/screens.sh). Local sessions already have their own nsh.
set -euo pipefail
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi
cd "${CLAUDE_PROJECT_DIR:-.}"
if bin="$(scripts/install-nsh.sh)"; then
  [ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export PATH=\"$bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
else
  # Never block the session: the client checks just won't run here.
  echo "session-start: nsh not installed (see above); client checks will run in CI only" >&2
fi
