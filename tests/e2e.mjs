// 使い方: node tests/e2e.mjs <拡張のディレクトリ> <engine: browser-0.8b|browser-2b|server>
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
const [ext, engine = "browser-0.8b"] = process.argv.slice(2);
const site = new URL("./site/", import.meta.url);
const srv = createServer((req, res) => {
  let body;
  try { body = readFileSync(new URL("." + req.url.replace(/\/$/, "/index.html"), site)); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": "text/html" }).end(body);
}).listen(8899, "127.0.0.1");
const ctx = await chromium.launchPersistentContext(process.env.PROFILE || "", { executablePath: process.env.CHROME_BIN || undefined, headless: true,
  viewport: { width: 1100, height: 760 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--enable-unsafe-webgpu"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
await sw.evaluate((e) => chrome.storage.local.set({ settings: { engine: e, pageMode: "bilingual", selectionButton: true } }), engine);
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8899/");
await page.waitForTimeout(300);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).sort((a, b) => b.id - a.id)[0].id);
const call = (fn) => sw.evaluate(([id, f]) => run(id, 0, new Function(`return globalThis.__plamoTranslate?.${f}()`)), [tabId, fn]);
// 拡張の UI は closed な shadow root の中にあるので、content script の分離された環境の inspect() で状態を読む
const inspect = () => sw.evaluate(async (id) => (await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: () => globalThis.__plamoTranslate?.inspect() }))[0]?.result ?? null, tabId);
const select = (sel) => page.evaluate((s) => { const r = document.createRange(); r.selectNodeContents(document.querySelector(s)); getSelection().removeAllRanges(); getSelection().addRange(r); }, sel);
const waitWindow = async (limitSec) => {
  let lastTitle = "";
  for (let i = 0; i < limitSec * 4; i++) {
    const w = (await inspect())?.window;
    const r = w && { title: w.title, ps: w.paragraphs.map((p) => ({ cls: p.cls, t: p.text })) };
    if (r && r.title !== lastTitle && /準備中/.test(r.title)) { if (!lastTitle || /[05]0%|9\d%/.test(r.title)) console.log("   ", r.title); lastTitle = r.title; }
    if (r && r.ps.length && !r.ps.some((p) => p.cls === "pending" || p.cls === "streaming")) return r;
    await page.waitForTimeout(250);
  }
  return "timeout";
};
for (const sel of ["#en", "#en", "#multi", "#ja"]) {
  await select(sel);
  const t0 = Date.now();
  await call("translateSelection");
  const r = await waitWindow(600);
  console.log(sel, `${((Date.now() - t0) / 1000).toFixed(2)}s`, JSON.stringify(r?.ps?.map((p) => (p.cls === "error" ? "ERROR: " : "") + p.t) ?? r));
}
await page.keyboard.press("Escape");
const t1 = Date.now();
await call("translatePage");
for (let i = 0; i < 480; i++) {
  const s = (await inspect())?.status ?? "";
  if (/翻訳済み|接続できません|できません/.test(s)) { console.log("page:", s, `${((Date.now() - t1) / 1000).toFixed(1)}s`); break; }
  await page.waitForTimeout(250);
}
console.log("status:", JSON.stringify(await sw.evaluate(() => engineStatus())));
await ctx.close();
srv.close();
