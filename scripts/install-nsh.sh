#!/bin/sh
# Installs the NSH CLI this repository pins (app/nsh-version) on Linux x86_64:
# the build CI made of that commit, from this repository's release `nsh-<commit>`
# (the ci workflow's `nsh` job publishes it). Used by CI and by Claude Code cloud
# sessions (.claude/hooks/session-start.sh); on a Mac, build nsh as README says.
#
#   scripts/install-nsh.sh            install into ~/.local/share/nsh/<commit>, link ~/.local/bin/nsh
#   NSH_HOME=/x scripts/install-nsh.sh   install somewhere else
#
# Prints the directory holding `nsh` (add it to PATH). Does nothing when that
# version is already installed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIN="$(tr -d ' \n' < "$ROOT/app/nsh-version")"
SHORT="$(echo "$PIN" | cut -c1-12)"
REPO="${NSH_RELEASE_REPO:-Sailfishc/noop}"
HOME_DIR="${NSH_HOME:-$HOME/.local/share/nsh}"
DEST="$HOME_DIR/$SHORT"
BIN="$HOME/.local/bin"

if [ -x "$DEST/nsh/bin/nsh" ]; then
  mkdir -p "$BIN" && ln -sf "$DEST/nsh/bin/nsh" "$BIN/nsh"
  echo "$DEST/nsh/bin"
  exit 0
fi
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ;;
  *) echo "install-nsh: only Linux x86_64 has a prebuilt nsh; build commit $PIN as README says" >&2; exit 1 ;;
esac

URL="https://github.com/$REPO/releases/download/nsh-$SHORT/nsh-linux-x86_64.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "install-nsh: downloading nsh $SHORT" >&2
curl -fsSL --retry 3 -o "$TMP/nsh.tar.gz" "$URL"
curl -fsSL --retry 3 -o "$TMP/nsh.tar.gz.sha256" "$URL.sha256"
(cd "$TMP" && sha256sum --check --status nsh.tar.gz.sha256) || { echo "install-nsh: checksum mismatch for $URL" >&2; exit 1; }
mkdir -p "$DEST"
tar -xzf "$TMP/nsh.tar.gz" -C "$DEST"
"$DEST/nsh/bin/nsh" --version >&2
mkdir -p "$BIN" && ln -sf "$DEST/nsh/bin/nsh" "$BIN/nsh"
echo "$DEST/nsh/bin"
