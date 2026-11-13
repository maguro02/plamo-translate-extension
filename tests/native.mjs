// 使い方: node tests/native.mjs <拡張のディレクトリ> <ネイティブホストの設定ファイル>
// 拡張から翻訳サーバーを起動・停止し、ブラウザを閉じるとサーバーも止まることを確かめる。8802 番を空けてから実行する
import { mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
const [ext, hostManifest] = process.argv.slice(2);
const health = () => fetch("http://127.0.0.1:8802/health").then((r) => r.status, () => 0);
const llamaProcs = () => { try { return execSync("pgrep -f 'server-mac/llama-metal/llama-server'").toString().trim().split("\n").filter(Boolean).length; } catch { return 0; } };

const launch = async (withHost) => {
  const dir = mkdtempSync(join(tmpdir(), "plamo-native-"));
  if (withHost) {
    mkdirSync(join(dir, "NativeMessagingHosts"));
    copyFileSync(hostManifest, join(dir, "NativeMessagingHosts", "jp.plamo_translate.server.json"));
  }
  const ctx = await chromium.launchPersistentContext(dir, { executablePath: process.env.CHROME_BIN || undefined, headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--enable-unsafe-webgpu"] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
  return { ctx, sw };
};
const state = (sw) => sw.evaluate(() => ({ ...native, text: nativeText(), engine: currentEngine() }));
const waitFor = async (sw, pred, sec, label) => {
  const t0 = Date.now(); let last = "";
  for (let i = 0; i < sec * 4; i++) {
    const s = await state(sw);
    if (s.text !== last && !/%/.test(s.text.slice(-4)) || /[05]0%$/.test(s.text)) { if (s.text !== last) console.log(`   ${((Date.now() - t0) / 1000).toFixed(1)}s ${s.text}`); }
    last = s.text;
    if (pred(s)) return { ...s, sec: ((Date.now() - t0) / 1000).toFixed(1) };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { timeout: label };
};

// 1. 登録なし
{
  const { ctx, sw } = await launch(false);
  await sw.evaluate(() => queryNative());
  const s = await state(sw);
  console.log("[not registered] installed:", s.installed, "|", s.text);
  await ctx.close();
}
// 2. 起動 → 翻訳 → 停止
const { ctx, sw } = await launch(true);
console.log("[extension id]", sw.url().split("/")[2]);
await sw.evaluate(() => queryNative());
let s = await state(sw);
console.log("[registered] installed:", s.installed, "running:", s.running, "| health:", await health());
await sw.evaluate(() => startServer(null));
s = await waitFor(sw, (x) => x.running && x.managed || x.error, 120, "start");
console.log("[started]", JSON.stringify({ sec: s.sec, running: s.running, managed: s.managed, error: s.error, engine: s.engine }), "| health:", await health(), "| llama-server procs:", llamaProcs());
const out = await sw.evaluate(async () => { await refreshServer(true); const t = performance.now(); const r = await enqueue(-1, { text: "The build is green, but one lint warning remains.", target: "ja", history: [] }); return { ...r, ms: Math.round(performance.now() - t), engine: currentEngine() }; });
console.log("[translate]", JSON.stringify(out));
await sw.evaluate(() => stopServer(null));
s = await waitFor(sw, (x) => !x.running && !x.managed, 30, "stop");
await new Promise((r) => setTimeout(r, 500));
console.log("[stopped]", JSON.stringify({ sec: s.sec, running: s.running }), "| health:", await health(), "| llama-server procs:", llamaProcs());
// 3. 起動したままブラウザを閉じる
await sw.evaluate(() => startServer(null));
s = await waitFor(sw, (x) => x.running && x.managed || x.error, 120, "restart");
console.log("[restarted]", JSON.stringify({ sec: s.sec }), "| health:", await health());
await ctx.close();
for (let i = 0; i < 20 && (await health()) === 200; i++) await new Promise((r) => setTimeout(r, 500));
console.log("[browser closed] health:", await health(), "| llama-server procs:", llamaProcs());
// 4. 翻訳を始めたときに自動で起動する
{
  const { ctx, sw } = await launch(true);
  await sw.evaluate(() => chrome.storage.local.set({ settings: { engine: "auto", form: "polite", autoStartServer: true } }));
  await new Promise((r) => setTimeout(r, 300));
  const first = await sw.evaluate(async () => { const r = await enqueue(-1, { text: "Hello world.", target: "ja", history: [] }); return { ...r, engine: currentEngine() }; });
  console.log("[auto-start] first request:", JSON.stringify(first));
  s = await waitFor(sw, (x) => x.running && x.managed || x.error, 120, "auto");
  const later = await sw.evaluate(async () => { const r = await enqueue(-1, { text: "Hello world.", target: "ja", history: [] }); return { ...r, engine: currentEngine() }; });
  console.log("[auto-start] after start:", JSON.stringify({ sec: s.sec }), JSON.stringify(later));
  await ctx.close();
  for (let i = 0; i < 20 && (await health()) === 200; i++) await new Promise((r) => setTimeout(r, 500));
  console.log("[auto-start] browser closed, health:", await health());
}
