// 使い方: node tests/stream.mjs <拡張のディレクトリ> <engine>  最初の文字が出るまでの時間と、訳し終えるまでの時間を測る
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
const [ext, engine = "browser-0.8b"] = process.argv.slice(2);
const site = new URL("./site/", import.meta.url);
const srv = createServer((req, res) => {
  let body; try { body = readFileSync(new URL("." + req.url, site)); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": "text/html" }).end(body);
}).listen(8899, "127.0.0.1");
const ctx = await chromium.launchPersistentContext(process.env.PROFILE || "", { executablePath: process.env.CHROME_BIN || undefined, headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--enable-unsafe-webgpu"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
await sw.evaluate((e) => chrome.storage.local.set({ settings: { engine: e, form: "polite", pageMode: "bilingual", selectionButton: true } }), engine);
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8899/long.html");
await page.waitForTimeout(300);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).sort((a, b) => b.id - a.id)[0].id);
const call = (fn) => sw.evaluate(([id, f]) => run(id, 0, new Function(`return globalThis.__plamoTranslate?.${f}()`)), [tabId, fn]);
const select = (sel) => page.evaluate((s) => { const r = document.createRange(); r.selectNodeContents(document.querySelector(s)); getSelection().removeAllRanges(); getSelection().addRange(r); }, sel);
// 窓の中身をページ内で 10ms ごとに見張り、最初の文字が出た時刻と確定した時刻を記録する
const measure = () => page.evaluate(() => new Promise((resolve) => {
  const t0 = performance.now();
  let first = null;
  const samples = [];
  const tick = () => {
    const w = document.querySelector("plamo-translate")?.shadowRoot?.querySelector(".window");
    const ps = w ? [...w.querySelectorAll(".body p")] : [];
    const text = ps.map((p) => p.textContent).join("");
    if (!first && text.trim()) first = performance.now() - t0;
    if (text && samples.at(-1) !== text.length) samples.push(text.length);
    if (ps.length && ps.every((p) => !p.classList.contains("pending") && !p.classList.contains("streaming"))) {
      resolve({ firstMs: Math.round(first), doneMs: Math.round(performance.now() - t0), updates: samples.length, chars: text.length });
    } else setTimeout(tick, 10);
  };
  tick();
}));
await select("#warm"); await call("translateSelection"); await measure();
for (let i = 0; i < 3; i++) {
  await page.keyboard.press("Escape");
  await select("#long");
  const m = measure();
  await call("translateSelection");
  console.log("selection(long):", JSON.stringify(await m));
}
await page.keyboard.press("Escape");
await call("translatePage");
let partialSeen = 0;
for (let i = 0; i < 400; i++) {
  const s = await page.evaluate(() => {
    const trs = [...document.querySelectorAll("plamo-tr")];
    return { msg: document.querySelector("plamo-translate")?.shadowRoot?.querySelector(".status .msg")?.textContent ?? "", lens: trs.map((t) => t.textContent.length) };
  });
  if (s.lens.some((n, k) => n > 1)) partialSeen++;
  if (/翻訳済み/.test(s.msg)) { console.log("page:", s.msg, "| polls with text before done:", partialSeen); break; }
  await page.waitForTimeout(20);
}
await ctx.close();
srv.close();
