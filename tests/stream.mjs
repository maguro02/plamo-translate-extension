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
// 拡張の UI は closed な shadow root の中にあるので、content script の分離された環境の inspect() で状態を読む
const inspect = () => sw.evaluate(async (id) => (await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: () => globalThis.__plamoTranslate?.inspect() }))[0]?.result ?? null, tabId);
// 最初の文字が出た時刻と訳し終えた時刻は、拡張がページ内で記録した値を読む
const measure = async () => {
  for (let i = 0; i < 1200; i++) {
    const st = await inspect();
    const w = st?.window;
    if (st?.timings?.doneMs != null && w && !w.paragraphs.some((p) => p.cls === "pending" || p.cls === "streaming")) {
      return { ...st.timings, chars: w.paragraphs.map((p) => p.text).join("").length };
    }
    await page.waitForTimeout(50);
  }
  return "timeout";
};
await select("#warm"); await call("translateSelection"); await measure();
for (let i = 0; i < 3; i++) {
  await page.keyboard.press("Escape");
  await select("#long");
  await call("translateSelection");
  console.log("selection(long):", JSON.stringify(await measure()));
}
await page.keyboard.press("Escape");
await call("translatePage");
let partialSeen = 0;
for (let i = 0; i < 400; i++) {
  const lens = await page.evaluate(() => [...document.querySelectorAll("plamo-tr")].map((t) => t.textContent.length));
  const s = { msg: (await inspect())?.status ?? "", lens };
  if (s.lens.some((n, k) => n > 1)) partialSeen++;
  if (/翻訳済み/.test(s.msg)) { console.log("page:", s.msg, "| polls with text before done:", partialSeen); break; }
  await page.waitForTimeout(50);
}
await ctx.close();
srv.close();
