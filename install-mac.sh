#!/bin/sh
# Let It Snow — one-line installer for macOS.
#   curl -fsSL https://raw.githubusercontent.com/tasvirlab/let-it-snow/main/install-mac.sh | sh
# Files downloaded with curl don't get macOS's quarantine flag, so the app opens straight away
# (no "is damaged" message — the app isn't notarized by Apple, which needs a paid developer account).
set -e

if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then ARCH=arm64; else ARCH=x64; fi
URL="https://github.com/tasvirlab/let-it-snow/releases/latest/download/LetItSnow-mac-$ARCH.dmg"
APP="/Applications/Let It Snow.app"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "❄  Downloading Let It Snow ($ARCH)…"
curl -fL --progress-bar "$URL" -o "$TMP/LetItSnow.dmg"

echo "❄  Installing to /Applications…"
MNT=$(hdiutil attach -nobrowse -readonly "$TMP/LetItSnow.dmg" | tail -1 | awk -F'\t' '{print $NF}')
osascript -e 'quit app "Let It Snow"' >/dev/null 2>&1 || true
rm -rf "$APP"
cp -R "$MNT/Let It Snow.app" /Applications/
hdiutil detach "$MNT" -quiet || true
xattr -cr "$APP" 2>/dev/null || true

open "$APP"
echo "❄  Done! Let It Snow is in your menu bar."
