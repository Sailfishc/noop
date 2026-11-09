#!/usr/bin/env bash
# Prepares app/ for a release build (CI only; it edits tracked files in the runner's checkout):
#   - app/version.ts and nsh.json's version: the release, e.g. 0.2.0
#   - nsh.json's "updater": where installed apps look for updates and the keys they trust.
#
# The public keys are not in the repository (as LoopMe keeps its Sparkle key out of project.yml): a build without
# them has no "updater" and never updates itself, so local and fork builds stay off. See docs/app-updates.md.
#
#   VERSION              0.2.0 (required)
#   REMI_UPDATE_ROOT     root public key (root.pub): certifies the release key; OTA packages must chain to it
#   REMI_UPDATE_KEY      release public key (release.pub): latest.json must be signed by it
#   GITHUB_REPOSITORY    where the releases are (default Sailfishc/noop)
#   REQUIRE_KEYS=1       fail when the keys are missing (a tag build)
set -euo pipefail
cd "$(dirname "$0")/../app"
: "${VERSION:?set VERSION}"
REPO="${GITHUB_REPOSITORY:-Sailfishc/noop}"

printf 'export const CLIENT_VERSION = "%s";\n' "$VERSION" > version.ts

if [ -n "${REMI_UPDATE_ROOT:-}" ] && [ -n "${REMI_UPDATE_KEY:-}" ]; then
  jq --arg v "$VERSION" --arg repo "$REPO" --arg key "$REMI_UPDATE_KEY" --arg root "$REMI_UPDATE_ROOT" \
    '.version = $v | .updater = { github: $repo, publicKey: $key, packages: { roots: [$root] } }' nsh.json > nsh.json.tmp
  echo "updates on: $REPO, release key $REMI_UPDATE_KEY, root $REMI_UPDATE_ROOT"
elif [ -n "${REQUIRE_KEYS:-}" ]; then
  echo "::error::a release needs the repository variables REMI_UPDATE_ROOT and REMI_UPDATE_KEY (scripts/release-keys.sh)" >&2
  exit 1
else
  jq --arg v "$VERSION" '.version = $v | del(.updater)' nsh.json > nsh.json.tmp
  echo "updates off: REMI_UPDATE_ROOT / REMI_UPDATE_KEY not set"
fi
mv nsh.json.tmp nsh.json
