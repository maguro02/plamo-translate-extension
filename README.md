# PLaMo 翻訳（ローカル）

選択したテキストやページ全体を、翻訳モデル [PLaMo 3 Translate](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF)（Preferred Networks）で翻訳する Chrome 拡張です。翻訳は自分の PC の中で行い、文章を外部に送りません。Built with PLaMo。

Preferred Networks とは関係のない非公式のツールです。

## 機能

- **選択範囲の翻訳**: テキストを選択するとカーソル位置に「訳」ボタンが出ます。右クリックメニューやショートカット（`Alt+Shift+T`）でも訳せます。翻訳ウインドウはドラッグで動かせ、訳文は生成しながら表示します。直近50件の翻訳履歴を残します。
- **ページ全体の翻訳**: 原文の下に訳文を出す対訳表示と、原文を訳文に置き換える表示を選べます。画面に見えている段落・記事本文から順に訳します。
- **翻訳エンジン**: Chrome の中で動かす（WebGPU、0.8B / 2B）か、同梱の翻訳サーバー（llama.cpp、2B）を使います。「自動」では、翻訳サーバーが起動していればそちらを使います。
- **翻訳サーバー**（任意）: Windows と Mac（Apple シリコン）用。初回に翻訳モデルの最新版をダウンロードします。一度起動したあとは、拡張から起動・停止できます。
- 日本語⇔英語を自動で判定し、日本語に訳すときの文体（です・ます / だ・である）を選べます。

## 使い方

[Releases](https://github.com/maguro02/plamo-translate-extension/releases) から `plamo-translate-<version>.zip` をダウンロードして展開し、中の `README.md` の手順に従ってください。

1. Chrome で `chrome://extensions` を開き、デベロッパー モードをオンにして、展開した `extension` フォルダを読み込みます。これだけでブラウザ内で翻訳できます。
2. 速くしたいときは、`server-windows/PLaMoTranslateServer.exe`（Mac は `server-mac/start-server.command`）を起動します。

拡張の使い方は [`chrome-extension/README.md`](chrome-extension/README.md)、配布物の説明は [`bundle/README.md`](bundle/README.md) にあります。

## 構成

| パス | 内容 |
|---|---|
| `chrome-extension/` | Chrome 拡張（Manifest V3）。`vendor/wllama/` にブラウザ用の推論エンジン（llama.cpp の WebAssembly 版） |
| `launcher/` | 翻訳サーバーの起動プログラム（Go）。モデルの取得・更新、llama-server の起動、Chrome のネイティブメッセージングホスト |
| `bundle/` | 配布用 zip に入れる説明書と Mac 用の起動ファイル |
| `scripts/` | 配布用 zip の作成、wllama の取り込み、拡張 ID の計算 |
| `tests/` | Playwright で拡張を読み込んで動かすテスト |

## 仕組み

- **ブラウザ内の翻訳**: 拡張の offscreen document で [wllama](https://github.com/ngxson/wllama) を動かし、WebGPU と WebAssembly のマルチスレッドを使います。モデル（公式 GGUF の Q4_K_M）は初回に Hugging Face から取得し、ブラウザ内（OPFS）に保存します。
- **翻訳サーバー**: 公式のビルド済み llama.cpp（Windows は Vulkan 版と CPU 版、Mac は Metal 版）を `127.0.0.1:8802` で起動します。拡張は OpenAI 互換の API にストリーミングで問い合わせます。
- **拡張からの起動・停止**: 起動プログラムが自分を Chrome のネイティブメッセージングホスト（`jp.plamo_translate.server`）として登録し、拡張から呼び出されると翻訳サーバーを起動します。拡張の ID は `manifest.json` の `key` で固定しています。
- **プロンプト**: PLaMo の PFML3 形式で、ページのタイトル・サイト名・前後の段落を参考文脈として渡します。

## ソースからのビルド

必要なもの: Go 1.24 以降、Docker（wllama のビルド）、Python 3、`zip`、`curl`、Node.js（テスト）。

### wllama

PLaMo 3 のトークナイザに対応した llama.cpp を含む wllama をソースからビルドし、拡張に取り込みます。`chrome-extension/vendor/wllama/` にはビルド済みのものが入っていて、取り込んだ版は `VERSION` に記録しています。

```sh
git clone https://github.com/ngxson/wllama && cd wllama && git submodule update --init
npm ci && npm run build:wasm && npm run build
<このリポジトリ>/scripts/update-wllama.sh .
```

### 配布用 zip

```sh
scripts/package-bundle.sh      # dist/plamo-translate-<version>.zip（拡張＋Windows / Mac 用の翻訳サーバー）
scripts/package-extension.sh   # dist/plamo-translate-extension-<version>.zip（拡張だけ）
```

llama.cpp のビルド済み配布物（`scripts/package-bundle.sh` の `LLAMA_TAG`）は `.cache/llama.cpp/` に取得して使います。起動プログラムには、ネイティブメッセージングで呼び出してよい拡張の ID をビルド時に埋め込みます。

### 拡張の ID

`chrome-extension/manifest.json` の `key`（公開鍵）で、拡張の ID を `mbjageocdfadjggjghbdmnlpphjehklo` に固定しています。フォークして別の ID で配布する場合は、新しい鍵を作って `key` を差し替えてください。ID は `scripts/extension-id.sh` で計算でき、`scripts/package-bundle.sh` が起動プログラムに埋め込みます。

```sh
openssl genrsa -out extension.pem 2048
openssl rsa -in extension.pem -pubout -outform DER | base64   # manifest.json の key に設定する
```

秘密鍵（`extension.pem`）は公開しないでください。

## テスト

```sh
npm install
npx playwright install chromium
npm run test:e2e        # ブラウザ内 0.8B で選択範囲とページを翻訳する（初回はモデルを取得）
npm run test:stream     # 最初の文字が出るまでと訳し終えるまでの時間
npm run test:launcher   # 起動プログラムの単体テスト
```

翻訳サーバーを使うテストは `node tests/e2e.mjs chrome-extension server`（`127.0.0.1:8802` で翻訳サーバーを起動しておく）。Playwright 同梱以外の Chromium を使うときは `CHROME_BIN` にパスを指定します。

## ライセンス

- このリポジトリのコード: [MIT License](LICENSE)
- 翻訳モデル PLaMo 3 Translate: [PLaMo Community License](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF)。モデルはこのリポジトリにも配布物にも含まず、利用者の環境で Hugging Face の公式リポジトリからダウンロードします。業務で使う場合は、ライセンスの商用利用の条件を確認してください。
- wllama: MIT License（`chrome-extension/vendor/wllama/LICENSE`）
- llama.cpp: MIT License（配布用 zip の `llama-*` フォルダに同梱）

PLaMo は Preferred Networks の商標です。
