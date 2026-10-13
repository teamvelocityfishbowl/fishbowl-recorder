#!/bin/bash
# Makes edit-ready copies of a tribute's Fishbowl answers:
# H.264 + AAC, constant 30 fps, 1280x720. This fixes WebM/VP9 files and the variable frame rate
# that browser recordings can have.
#
# Usage (Terminal):  ./tools/convert-for-premiere.sh "/path/to/Fishbowl 2027/Colin Knox"
# Needs ffmpeg:      brew install ffmpeg
set -euo pipefail
SRC="${1:?Drag a tribute folder onto this command}"
OUT="$SRC/_edit-ready"
mkdir -p "$OUT"
shopt -s nullglob
for f in "$SRC"/*.mp4 "$SRC"/*.webm "$SRC"/*.mov; do
  name="$(basename "${f%.*}")"
  echo "→ $name"
  ffmpeg -hide_banner -loglevel error -y -i "$f" \
    -vf "fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" \
    -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p \
    -c:a aac -b:a 192k -ar 48000 -movflags +faststart "$OUT/$name.mp4"
done
echo "Done. Edit-ready files are in: $OUT"
