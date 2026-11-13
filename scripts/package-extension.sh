#!/bin/bash
# chrome-extension/ を配布用の zip にまとめる。出力: dist/plamo-translate-extension-<version>.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/chrome-extension"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SRC/manifest.json")"
OUT="$ROOT/dist/plamo-translate-extension-$VERSION.zip"

mkdir -p "$ROOT/dist"
rm -f "$OUT"
# 展開したフォルダをそのまま Chrome に読み込めるよう、トップに plamo-translate-extension/ を置く
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude ".DS_Store" "$SRC/" "$STAGE/plamo-translate-extension/"
(cd "$STAGE" && zip -qr "$OUT" plamo-translate-extension)
echo "$OUT ($(du -h "$OUT" | cut -f1))"
