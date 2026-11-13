#!/bin/bash
# manifest.json の key から拡張機能 ID を計算して出力する
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 -c '
import base64, hashlib, json, sys
key = json.load(open(sys.argv[1]))["key"]
print("".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]))
' "$ROOT/chrome-extension/manifest.json"
