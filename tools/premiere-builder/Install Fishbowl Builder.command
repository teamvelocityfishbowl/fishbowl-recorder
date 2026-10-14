#!/bin/bash
# Installs (or updates) the Fishbowl Builder panel for Premiere Pro. Double-click to run.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)/extension"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.teamvelocity.fishbowlbuilder"
mkdir -p "$DEST"
rsync -a --delete --exclude "*.gz" "$SRC/" "$DEST/"
# Audio tools used for dead-air trimming and voice leveling
if [ -f "$DEST/bin/ffmpeg" ]; then
  chmod +x "$DEST/bin/ffmpeg"
  xattr -d com.apple.quarantine "$DEST/bin/ffmpeg" 2>/dev/null || true
elif ! command -v ffmpeg >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/ffmpeg ]; then
  echo "⚠️  ffmpeg wasn't found, so dead-air trimming and voice leveling will be skipped."
fi
# Let Premiere load panels that aren't from the Adobe Exchange (one-time setting)
for v in 9 10 11 12 13 14; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
echo ""
echo "✅  Fishbowl Builder is installed."
echo ""
echo "Next: quit and reopen Premiere Pro, then open"
echo "      Window → Extensions → Fishbowl Builder"
echo ""
read -n 1 -s -r -p "Press any key to close this window."
