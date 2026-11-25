#!/usr/bin/env sh
# Coverflux – installs the extension into Spicetify and applies it (macOS / Linux).
# Usage:  sh ./install.sh
set -e
cd "$(dirname "$0")"

if ! command -v spicetify >/dev/null 2>&1; then
  for p in "$HOME/.spicetify/spicetify" "$HOME/.local/bin/spicetify"; do
    [ -x "$p" ] && PATH="$(dirname "$p"):$PATH" && break
  done
fi
if ! command -v spicetify >/dev/null 2>&1; then
  echo "Spicetify CLI nicht gefunden. Installiere sie zuerst (offizieller Installer):"
  echo "  curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh"
  echo "Danach dieses Skript erneut ausführen."
  exit 1
fi

EXT="$(dirname "$(spicetify -c)")/Extensions"
mkdir -p "$EXT"
cp dist/coverflux.js "$EXT/coverflux.js"
echo "coverflux.js -> $EXT"

spicetify config extensions coverflux.js
# backup apply works for a fresh Spotify and after Spotify updates
spicetify backup apply || spicetify apply
echo "Fertig. Spotify neu starten -> Knopf rechts in der Playbar neben dem Lyrics-Knopf."
