#!/bin/bash
# Chrome 拡張と Windows / Mac 用の翻訳サーバーを 1 つの zip にまとめる。
# 出力: dist/plamo-translate-<version>.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LLAMA_TAG="b12125"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/chrome-extension/manifest.json")"
NAME="plamo-translate-$VERSION"
CACHE="$ROOT/.cache/llama.cpp/$LLAMA_TAG"
OUT="$ROOT/dist/$NAME.zip"

fetch() {
  local file="llama-$LLAMA_TAG-bin-$1"
  if [ ! -f "$CACHE/$file" ]; then
    mkdir -p "$CACHE"
    curl -fL --retry 3 -o "$CACHE/$file.part" "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/$file"
    mv "$CACHE/$file.part" "$CACHE/$file"
  fi
  echo "$CACHE/$file"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/$NAME"
mkdir -p "$STAGE/server-windows" "$STAGE/server-mac"

rsync -a --exclude ".DS_Store" "$ROOT/chrome-extension/" "$STAGE/extension/"
cp "$ROOT/bundle/README.md" "$STAGE/README.md"

# 起動プログラムには、ネイティブホストとして呼び出してよい拡張の ID を埋め込む
EXT_ID="$("$ROOT/scripts/extension-id.sh")"
LDFLAGS="-s -w -X main.extensionID=$EXT_ID"
(cd "$ROOT/launcher" &&
  GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$LDFLAGS" -o "$STAGE/server-windows/PLaMoTranslateServer.exe" . &&
  GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "$LDFLAGS" -o "$STAGE/server-mac/plamo-translate-server" .)

unzip -q "$(fetch win-vulkan-x64.zip)" -d "$STAGE/server-windows/llama-vulkan"
unzip -q "$(fetch win-cpu-x64.zip)" -d "$STAGE/server-windows/llama-cpu"
mkdir -p "$STAGE/server-mac/llama-metal"
tar xzf "$(fetch macos-arm64.tar.gz)" -C "$STAGE/server-mac/llama-metal" --strip-components 1
cp "$ROOT/bundle/start-server.command" "$STAGE/server-mac/start-server.command"
# Windows 版の配布物には llama.cpp 本体の LICENSE が入っていないので、Mac 版のものを添える
cp "$STAGE/server-mac/llama-metal/LICENSE" "$STAGE/server-windows/llama-vulkan/LICENSE"
cp "$STAGE/server-mac/llama-metal/LICENSE" "$STAGE/server-windows/llama-cpu/LICENSE"

mkdir -p "$ROOT/dist"
rm -f "$OUT"
(cd "$WORK" && zip -qry "$OUT" "$NAME")
echo "$OUT ($(du -h "$OUT" | cut -f1))"
