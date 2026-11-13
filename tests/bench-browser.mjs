// 使い方: node tests/bench-browser.mjs <拡張のディレクトリ> <engine>
import { chromium } from "playwright";
const [ext, engine = "browser-0.8b"] = process.argv.slice(2);
const LONG = "The root cause is that the cache key only includes the user ID, not the tenant ID. When the same user belongs to two tenants, the second request reads the first tenant's cached permissions, which is why the dashboard briefly shows projects the user should not see. I changed buildCacheKey() in src/auth/cache.ts to include the tenant ID and added a regression test that logs in to two tenants in sequence. The fix is backward compatible: old cache entries simply miss and are rebuilt on the next request, so no migration is needed.";
const SHORT = "Should I also update the migration scripts, or keep this change limited to the API layer?";
const ctx = await chromium.launchPersistentContext(process.env.PROFILE || "", { executablePath: process.env.CHROME_BIN || undefined, headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--enable-unsafe-webgpu"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
const r = await sw.evaluate(async ([engine, LONG, SHORT]) => {
  const out = [];
  const time = async (label, text) => {
    const t = performance.now();
    const res = await completeInBrowser({ text, target: "ja", history: [] }, engine).catch((e) => "ERROR " + e.message);
    out.push({ label, ms: Math.round(performance.now() - t), chars: res.length, text: res.slice(0, 80) });
  };
  await time("first call (load)", SHORT);
  for (let i = 0; i < 3; i++) await time("short", SHORT);
  for (let i = 0; i < 3; i++) await time("long", LONG);
  return out;
}, [engine, LONG, SHORT]);
for (const x of r) console.log(`${x.label.padEnd(18)} ${String(x.ms).padStart(6)}ms ${x.chars}字 ${x.text}`);
await ctx.close();
