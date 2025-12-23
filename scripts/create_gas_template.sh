#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/gas"
DEST="$ROOT/dist/gas"

mkdir -p "$DEST"

echo "Generating GAS payload..."
if [[ -n "${SPREADSHEET_ID:-}" ]]; then
  sed "s/{{SPREADSHEET_ID}}/${SPREADSHEET_ID}/g" "$SRC/Code.gs" > "$DEST/Code.gs"
  echo "Injected SPREADSHEET_ID from environment."
else
  cp "$SRC/Code.gs" "$DEST/Code.gs"
  echo "No SPREADSHEET_ID provided. Placeholderをそのまま出力します。"
fi

cp "$SRC/appsscript.json" "$DEST/appsscript.json"

ZIP_PATH="$ROOT/dist/squat-gas.zip"
rm -f "$ZIP_PATH"
(
  cd "$DEST"
  zip -q "../squat-gas.zip" Code.gs appsscript.json
)

echo "Done. Files:"
echo " - $DEST/Code.gs"
echo " - $DEST/appsscript.json"
echo " - $ZIP_PATH"
