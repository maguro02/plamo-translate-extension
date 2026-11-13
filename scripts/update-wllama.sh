#!/bin/bash
# ビルドした wllama（esm/index.js と esm/wasm/wllama.wasm）を拡張に取り込む。引数: wllama のリポジトリのパス
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WLLAMA="${1:?usage: update-wllama.sh <wllama repo>}"
DEST="$ROOT/chrome-extension/vendor/wllama"

mkdir -p "$DEST/wasm"
cp "$WLLAMA/esm/index.js" "$DEST/index.js"
cp "$WLLAMA/esm/wasm/wllama.wasm" "$DEST/wasm/wllama.wasm"
cp "$WLLAMA/LICENCE" "$DEST/LICENSE"
echo "llama.cpp: $(git -C "$WLLAMA/llama.cpp" log -1 --format='%h %ad' --date=short)" > "$DEST/VERSION"
echo "wllama: $(git -C "$WLLAMA" log -1 --format='%h %ad' --date=short)" >> "$DEST/VERSION"
cat "$DEST/VERSION"
