#!/usr/bin/env bash
# One-time setup of the keys Remi's app updates are signed with (docs/app-updates.md). Run it on the Mac you release
# from, with nsh (app/nsh-version). The keys stay on that Mac: nothing goes to GitHub or into the repository.
#
#   scripts/release-keys.sh          create the keys
#   scripts/release-keys.sh renew    certify the same release key again (the certificate lasts DAYS days)
#
# Two keys, as nsh's signed packages want them:
#   root     certifies the release key. Installed apps trust its public key; lose its secret and they can no longer
#            take OTA packages. Back it up offline.
#   release  signs latest.json and the OTA packages (scripts/release-mac.sh). Installed apps check latest.json
#            against its public key, so keep this key: renew its certificate instead of making a new one.
#
#   KEYS=~/.remi-release-keys   where the key files live
#   DAYS=730                    how long the release key may sign
set -euo pipefail
KEYS="${KEYS:-$HOME/.remi-release-keys}"
DAYS="${DAYS:-730}"
APP_ID=dev.noop.app

command -v nsh > /dev/null || { echo "needs nsh on PATH (README: build NSH at app/nsh-version)"; exit 1; }
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

cat <<MSG

Done: $KEYS has root.{secret,pub} and release.{secret,pub,cert}.
Back up the whole folder offline (a password manager or an encrypted USB stick). Never commit anything from it.
The certificate is valid for $DAYS days; run '$0 renew' before then (needs root.secret).
MSG
