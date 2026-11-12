#!/usr/bin/env bash
# Builds, signs, notarizes and publishes a Remi release for macOS (Apple silicon) as the latest GitHub release,
# with the update feed installed apps follow (docs/app-updates.md). Modeled on LoopMe's apple/scripts/release-mac.sh.
# Run it on your Mac with nsh (app/nsh-version), Xcode's command line tools and the GitHub CLI (gh, logged in).
# Nothing here runs in CI: the keys and certificates never leave this Mac.
#
#   scripts/release-mac.sh             release the version and build in app/nsh.json
#   DRY_RUN=1 scripts/release-mac.sh   build, sign, notarize and write the feed, but don't publish
#
# Settings come from the environment or release.env at the repository root (git-ignored):
#   SIGN_IDENTITY     "Developer ID Application: Name (TEAMID)" (security find-identity -v -p codesigning)
#   NOTARY_PROFILE    notarytool keychain profile (xcrun notarytool store-credentials)
#   KEYS              update keys from scripts/release-keys.sh (default ~/.remi-release-keys)
#   GITHUB_REPO       default Sailfishc/noop
#   RELEASE_NOTES     text for the release page
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -f release.env ]; then set -a; . ./release.env; set +a; fi
: "${SIGN_IDENTITY:?set SIGN_IDENTITY (Developer ID Application: ...)}"
: "${NOTARY_PROFILE:?set NOTARY_PROFILE}"
KEYS="${KEYS:-$HOME/.remi-release-keys}"
REPO="${GITHUB_REPO:-Sailfishc/noop}"
for f in root.pub release.pub release.secret release.cert; do
  [ -f "$KEYS/$f" ] || { echo "missing $KEYS/$f: run scripts/release-keys.sh first"; exit 1; }
done
[ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] || { echo "run this on an Apple silicon Mac"; exit 1; }
command -v nsh > /dev/null || { echo "needs nsh on PATH (README)"; exit 1; }
command -v gh > /dev/null || { echo "needs the GitHub CLI: brew install gh && gh auth login"; exit 1; }

VERSION=$(jq -r .version app/nsh.json)
BUILD=$(jq -r .build app/nsh.json)
TAG="v$VERSION"
echo "==> Remi $VERSION ($BUILD) → $REPO@$TAG"

# The release is this commit as it is on GitHub: no local changes, and pushed.
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first"; exit 1; }
COMMIT=$(git rev-parse HEAD)
if [ -z "${DRY_RUN:-}" ]; then
  git fetch -q origin
  [ -n "$(git branch -r --contains "$COMMIT")" ] || { echo "push $COMMIT first"; exit 1; }
  if gh release view "$TAG" --repo "$REPO" > /dev/null 2>&1; then
    echo "release $TAG already exists: raise version and build in app/nsh.json"; exit 1
  fi
  LAST=$(gh release view --repo "$REPO" --json tagName -q .tagName 2> /dev/null || true)
  echo "    latest release now: ${LAST:-none}"
fi

WORK="$ROOT/.nsh/release"
rm -rf "$WORK" && mkdir -p "$WORK/app" "$WORK/out" "$WORK/feed"
# A copy of app/ with the release's version and the update source and keys: the tracked files stay as they are,
# so a local build has no updater (as LoopMe's builds without the public key).
rsync -a --exclude .nsh --exclude dist app/ "$WORK/app/"
printf 'export const CLIENT_VERSION = "%s";\n' "$VERSION" > "$WORK/app/version.ts"
jq --arg repo "$REPO" --arg key "$(cat "$KEYS/release.pub")" --arg root "$(cat "$KEYS/root.pub")" \
  '.updater = { github: $repo, publicKey: $key, packages: { roots: [$root] } }' app/nsh.json > "$WORK/app/nsh.json"

echo "==> packaging"
(cd "$WORK/app" && nsh package --target macos -o "$WORK/out" --build "$BUILD" --app-version "$VERSION")
APP="$WORK/out/Remi.app"
ARCHIVE=$(ls "$WORK/out"/Remi-"$VERSION"-macos-aarch64.tar.gz)
# nsh/updater unpacks this archive and swaps the app in: keep its layout, with the signed app in it.
tar -tzf "$ARCHIVE" | sort > "$WORK/layout.before"

echo "==> signing with $SIGN_IDENTITY"
codesign --force --deep --options runtime --timestamp --entitlements scripts/remi.entitlements --sign "$SIGN_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> notarizing"
ZIP="$WORK/feed/remi-macos-arm64.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
spctl --assess --type execute --verbose "$APP"
rm -f "$ZIP" && ditto -c -k --keepParent "$APP" "$ZIP"
UPDATE="$WORK/feed/remi-$VERSION-macos-arm64.tar.gz"
tar -czf "$UPDATE" -C "$WORK/out" Remi.app
tar -tzf "$UPDATE" | grep -Fxv 'Remi.app/Contents/CodeResources' | sort > "$WORK/layout.after"
diff -q "$WORK/layout.before" "$WORK/layout.after" > /dev/null || { echo "the signed archive's layout differs from nsh's:"; diff "$WORK/layout.before" "$WORK/layout.after" | head; exit 1; }

echo "==> OTA package and update manifest"
# The app's code, signed by the release key (certified by the root the apps trust): installed apps whose NSH runtime
# can run it take it without a new app. latest.json lists it and the whole app, signed by the release key.
PKG="$WORK/feed/remi-$VERSION.nshpkg"
(cd "$WORK/app" && nsh publish App.tsx --key "$KEYS/release.secret" --cert "$KEYS/release.cert" \
  --build "$BUILD" --app-version "$VERSION" -o "$PKG")
nsh verify --root "$KEYS/root.pub" "$PKG"
NOTES="${RELEASE_NOTES:-Remi $VERSION ($BUILD)}"
printf '%s\n' "$NOTES" > "$WORK/notes.txt"
nsh update-manifest "$UPDATE" --entry "$WORK/app" --key "$KEYS/release.secret" --package "$PKG" \
  --notes "$WORK/notes.txt" --out "$WORK/feed"
(cd "$WORK/feed" && shasum -a 256 * > sha256sums)

if [ -n "${DRY_RUN:-}" ]; then
  echo "==> dry run: $WORK/feed"; ls -l "$WORK/feed"; exit 0
fi
echo "==> publishing"
# Uploaded as a draft, then published as latest: releases/latest never points at a release without latest.json.
gh release create "$TAG" --repo "$REPO" --target "$COMMIT" --draft --title "Remi $VERSION" --notes "$NOTES" "$WORK/feed"/*
gh release edit "$TAG" --repo "$REPO" --draft=false --latest
echo "==> done: installed apps update to $VERSION within an hour (or 检查更新)"
