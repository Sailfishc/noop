#!/usr/bin/env bash
# One-time setup of the keys Remi's app updates are signed with (docs/app-updates.md). Run it on your own Mac,
# with nsh (app/nsh-version) and the GitHub CLI logged in to an account that can edit this repository's settings.
#
#   scripts/release-keys.sh          create the keys and store them in the repository's settings
#   scripts/release-keys.sh renew    certify the same release key again (the certificate lasts DAYS days)
#
# Two keys, as nsh's signed packages want them:
#   root     certifies the release key. Its secret never leaves this machine: keep a backup somewhere safe and
#            offline. Installed apps trust its public key; lose it and they can no longer take OTA packages.
#   release  signs latest.json and the OTA packages in CI. Its secret is a repository secret.
# Public keys become repository variables, which the release build writes into the app (scripts/release-config.sh).
#
#   KEYS=~/.remi-release-keys   where the key files live
#   REPO=Sailfishc/noop         the repository
#   DAYS=730                    how long the release key may sign
set -euo pipefail
KEYS="${KEYS:-$HOME/.remi-release-keys}"
REPO="${REPO:-Sailfishc/noop}"
DAYS="${DAYS:-730}"
APP_ID=dev.noop.app

command -v nsh > /dev/null || { echo "needs nsh on PATH (README: build NSH at app/nsh-version)"; exit 1; }
command -v gh > /dev/null || { echo "needs the GitHub CLI: brew install gh && gh auth login"; exit 1; }
mkdir -p "$KEYS" && chmod 700 "$KEYS"
cd "$KEYS"

if [ "${1:-}" != renew ]; then
  for k in root release; do
    [ ! -e "$k.secret" ] || { echo "$KEYS/$k.secret exists already: to extend the certificate run '$0 renew'"; exit 1; }
  done
  nsh keygen root
  nsh keygen release
fi
[ -f root.secret ] && [ -f release.pub ] || { echo "no keys in $KEYS"; exit 1; }
nsh certify --root root.secret --key release.pub --apps "$APP_ID" --days "$DAYS" -o release.cert

gh variable set REMI_UPDATE_ROOT --repo "$REPO" --body "$(cat root.pub)"
gh variable set REMI_UPDATE_KEY --repo "$REPO" --body "$(cat release.pub)"
gh secret set REMI_RELEASE_KEY --repo "$REPO" < release.secret
gh secret set REMI_RELEASE_CERT --repo "$REPO" < release.cert

cat <<MSG

Done. $REPO now has:
  variables REMI_UPDATE_ROOT, REMI_UPDATE_KEY   (public keys, built into the app)
  secrets   REMI_RELEASE_KEY, REMI_RELEASE_CERT (sign each release)

Back up $KEYS/root.secret offline (a password manager or an encrypted USB stick), then delete it from this Mac if
you like: renewing the certificate needs it, nothing else does. Never commit anything from $KEYS.
The certificate is valid for $DAYS days; run '$0 renew' before then.
MSG
