// 使い方: node tests/eval-context.mjs <拡張のディレクトリ>  （ブラウザ内 0.8B・です・ます調で、段落内の1文を選択して訳す）
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
const [ext] = process.argv.slice(2);
const site = new URL("./site/", import.meta.url);
const srv = createServer((req, res) => {
  let body; try { body = readFileSync(new URL("." + req.url, site)); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": "text/html" }).end(body);
}).listen(8899, "127.0.0.1");
const ctx = await chromium.launchPersistentContext(process.env.PROFILE || "", { executablePath: process.env.CHROME_BIN || undefined, headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--enable-unsafe-webgpu"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
await sw.evaluate(() => chrome.storage.local.set({ settings: { engine: "browser-0.8b", form: "polite", pageMode: "bilingual", selectionButton: true } }));
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8899/blog.html");
await page.waitForTimeout(300);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).sort((a, b) => b.id - a.id)[0].id);
const call = (fn) => sw.evaluate(([id, f]) => run(id, 0, new Function(`return globalThis.__plamoTranslate?.${f}()`)), [tabId, fn]);
// 拡張の UI は closed な shadow root の中にあるので、content script の分離された環境の inspect() で状態を読む
const inspect = () => sw.evaluate(async (id) => (await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: () => globalThis.__plamoTranslate?.inspect() }))[0]?.result ?? null, tabId);
const SENTENCES = [
  "It's a no-brainer: if you don't pin your dependencies, your builds will eventually break.",
  "The new release ships with a handful of breaking changes, so read the migration guide before upgrading.",
  "Under the hood, the scheduler batches requests to keep the GPU busy.",
  "This feature is opt-in and off by default.",
  "We'd love to hear your feedback, so drop us a line on GitHub.",
  "このPRのレビューコメントに対応して、型エラーを全部直してからコミットして。",
];
for (const s of SENTENCES) {
  await page.evaluate((s) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(s);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + s.length);
      getSelection().removeAllRanges(); getSelection().addRange(r); return;
    }
  }, s);
  await call("translateSelection");
  let out = "timeout";
  for (let i = 0; i < 400; i++) {
    const ps = (await inspect())?.window?.paragraphs ?? [];
    if (ps.length && !ps.some((p) => p.cls === "pending" || p.cls === "streaming")) { out = ps.map((p) => p.text).join(" "); break; }
    await page.waitForTimeout(150);
  }
  console.log("SRC:", s, "\n  ->", out);
}
await page.keyboard.press("Escape");
await call("translatePage");
for (let i = 0; i < 400; i++) {
  if (/翻訳済み/.test((await inspect())?.status ?? "")) break;
  await page.waitForTimeout(150);
}
console.log("\n[ページ翻訳]");
for (const t of await page.evaluate(() => [...document.querySelectorAll("plamo-tr")].map((t) => t.textContent))) console.log("  ", t);
await ctx.close();
srv.close();
