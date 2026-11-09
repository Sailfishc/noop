#!/usr/bin/env bash
# Installs the Remi client app, or updates it (Linux / macOS):
#   curl -fsSL https://raw.githubusercontent.com/Sailfishc/noop/main/install-client.sh | bash
# NOOP_CLIENT_BASE_URL  where the release assets are (default: the latest GitHub release)
set -euo pipefail

BASE="${NOOP_CLIENT_BASE_URL:-https://github.com/Sailfishc/noop/releases/latest/download}"

fail() { printf "Remi: %s\n" "$*" >&2; exit 1; }
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

case "$(uname -s)" in
  Darwin)
    # A shell under Rosetta reports x86_64 on an Apple silicon Mac, so ask the hardware.
    [ "$(sysctl -n hw.optional.arm64 2> /dev/null || true)" = 1 ] || fail "the macOS client needs Apple silicon"
    [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 14 ] || fail "the macOS client needs macOS 14 or later"
    ASSET=remi-macos-arm64.zip ;;
  Linux)
    [ "$(uname -m)" = x86_64 ] || fail "the Linux client needs x86_64"
    ASSET=remi-linux-x86_64.tar.gz ;;
  *) fail "use install-client.ps1 on Windows" ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "Downloading $ASSET"
curl -fsSL "$BASE/$ASSET" -o "$WORK/$ASSET"
curl -fsSL "$BASE/sha256sums" -o "$WORK/sha256sums"
# GitHub serves release downloads case-insensitively, and the manifest may spell the name either way
# (the 2026-11 lowercase rename shipped before a release carried the new names): match case-insensitively.
EXPECTED="$(awk -v asset="$ASSET" 'tolower($2) == tolower(asset) || tolower($2) == "*" tolower(asset) { print $1 }' "$WORK/sha256sums")"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$(sha256 "$WORK/$ASSET")" ] || fail "the checksum of $ASSET does not match"

if [ "$(uname -s)" = Darwin ]; then
  ditto -x -k "$WORK/$ASSET" "$WORK/unpacked"
  [ -d "$WORK/unpacked/Remi.app" ] || fail "$ASSET holds no Remi.app"
  APPS=/Applications
  if [ ! -w "$APPS" ]; then APPS="$HOME/Applications"; mkdir -p "$APPS"; fi
  rm -rf "$APPS/Remi.app"
  mv "$WORK/unpacked/Remi.app" "$APPS/Remi.app"
  printf "Installed %s/Remi.app\n\nOpen it from Launchpad or Spotlight. If it is running, quit it to use the new version.\n" "$APPS"
else
  tar -xzf "$WORK/$ASSET" -C "$WORK"
  [ -x "$WORK/Remi/Remi" ] || fail "$ASSET holds no Remi/Remi"
  DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
  DIR="$DATA/remi-client"
  rm -rf "$DIR"
  mkdir -p "$DATA" "$DATA/applications" "$DATA/icons/hicolor/512x512/apps" "$HOME/.local/bin"
  mv "$WORK/Remi" "$DIR"
  ln -sf "$DIR/Remi" "$HOME/.local/bin/remi-client"
  cp "$DIR/dev.noop.app.png" "$DATA/icons/hicolor/512x512/apps/dev.noop.app.png"
  sed "s|^Exec=.*|Exec=$DIR/Remi|" "$DIR/dev.noop.app.desktop" > "$DATA/applications/dev.noop.app.desktop"
  command -v update-desktop-database > /dev/null && update-desktop-database "$DATA/applications" > /dev/null 2>&1 || true
  printf "Installed %s\n\nOpen Remi from your launcher, or run remi-client.\n" "$DIR"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to your PATH to use the remi-client command." ;; esac
  MISSING="$(ldd "$DIR/Remi" 2> /dev/null | grep 'not found' || true)"
  if [ -n "$MISSING" ]; then
    printf "\nThe app needs GTK 4.14 or later and glibc 2.39 or later (Ubuntu 24.04 or newer). Missing:\n%s\n" "$MISSING"
    echo "On Debian or Ubuntu: sudo apt install libgtk-4-1"
  fi
  # Videos play through GStreamer: MP4 needs qtdemux (plugins-good), H.264 needs
  # libav, and hub URLs need souphttpsrc. Without them the player shows an error.
  if command -v pacman > /dev/null; then
    GST="$(for p in gst-plugins-good gst-libav; do pacman -Q "$p" > /dev/null 2>&1 || echo "$p"; done)"
    [ -z "$GST" ] || { echo "Installing GStreamer plug-ins for video playback: $GST"; sudo pacman -S --needed --noconfirm $GST || echo "Install them to play videos: sudo pacman -S $GST"; }
  elif command -v apt-get > /dev/null; then
    GST="$(for p in gstreamer1.0-plugins-good gstreamer1.0-libav; do dpkg -s "$p" > /dev/null 2>&1 || echo "$p"; done)"
    [ -z "$GST" ] || { echo "Installing GStreamer plug-ins for video playback: $GST"; sudo apt-get install -y $GST || echo "Install them to play videos: sudo apt install $GST"; }
  fi
fi
