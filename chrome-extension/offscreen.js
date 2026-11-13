import { CacheManager, Wllama } from "./vendor/wllama/index.js";

const MODELS = {
  "browser-0.8b": "https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/main/plamo-3-translate-0.8b-Q4_K_M.gguf",
  "browser-2b": "https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/main/plamo-3-translate-2b-Q4_K_M.gguf",
};
const STOP = ["<|plamo:tag|>", "<|plamo:bos|>"];
const quietLogger = { debug() {}, log() {}, warn() {}, error: (...a) => console.error(...a) };

let wllama = null;
let loadedModel = null;
let loading = null;
let chain = Promise.resolve();

const newWllama = () =>
  new Wllama({ default: chrome.runtime.getURL("vendor/wllama/wasm/wllama.wasm") }, { logger: quietLogger });

function report(model, loaded, total) {
  chrome.runtime.sendMessage({ type: "engine:progress", model, loaded, total }).catch(() => {});
}

async function ensureModel(model) {
  if (!MODELS[model]) throw new Error(`不明なモデルです: ${model}`);
  if (loadedModel === model) return;
  if (loading?.model === model) return loading.promise;
  const promise = (async () => {
    if (wllama) await wllama.exit().catch(() => {});
    wllama = null;
    loadedModel = null;
    const w = newWllama();
    // 2 回目以降はブラウザ内（OPFS）に保存したモデルを読むので、ダウンロードは初回だけになる
    await w.loadModelFromUrl(MODELS[model], {
      n_ctx: 4096,
      progressCallback: ({ loaded, total }) => report(model, loaded, total),
    });
    wllama = w;
    loadedModel = model;
  })();
  loading = { model, promise };
  try {
    await promise;
  } finally {
    if (loading?.promise === promise) loading = null;
  }
}

// wllama は 1 つのモデルで同時に 1 件しか生成できないので、要求を順番に処理する
function serialize(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

class FatalError extends Error {}

const PARTIAL_INTERVAL_MS = 50;
const stripStop = (text) => text.replace(/<\|plamo:(tag|bos)\|>[\s\S]*$/, "");

async function complete({ model, prompt, maxTokens, streamId }) {
  try {
    await ensureModel(model);
  } catch (e) {
    // モデルを用意できないと以降の段落もすべて失敗するので、呼び出し側でページ翻訳を止められるよう区別する
    throw new FatalError(errorText(e));
  }
  let text = "";
  let timer = null;
  let lastSent = 0;
  // 1 トークンごとに送るとメッセージの中継が詰まるので、50ms ごとにまとめて送る
  const flush = () => {
    timer = null;
    lastSent = performance.now();
    chrome.runtime.sendMessage({ type: "engine:partial", streamId, text: stripStop(text) }).catch(() => {});
  };
  try {
    await wllama.createCompletion({
      prompt,
      max_tokens: maxTokens,
      temperature: 0,
      stop: STOP,
      stream: true,
      onData: (chunk) => {
        text += chunk.choices?.[0]?.text ?? "";
        if (streamId != null && !timer) {
          timer = setTimeout(flush, Math.max(0, PARTIAL_INTERVAL_MS - (performance.now() - lastSent)));
        }
      },
    });
    clearTimeout(timer);
    return stripStop(text).trim();
  } catch (e) {
    clearTimeout(timer);
    // WebAssembly 側が異常終了すると以降の呼び出しもすべて失敗するので、次の要求でモデルを読み込み直す
    await wllama?.exit().catch(() => {});
    wllama = null;
    loadedModel = null;
    throw e;
  }
}

async function status() {
  const entries = await new CacheManager().list().catch(() => []);
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  return {
    loadedModel,
    webgpu: !!adapter,
    cached: Object.fromEntries(
      Object.entries(MODELS).map(([key, url]) => [key, entries.some((e) => e.metadata?.originalURL === url)])
    ),
    cacheBytes: entries.reduce((sum, e) => sum + (e.size || 0), 0),
  };
}

async function deleteModels() {
  await serialize(async () => {
    if (wllama) await wllama.exit().catch(() => {});
    wllama = null;
    loadedModel = null;
    await new CacheManager().clear();
  });
}

const errorText = (e) => {
  const m = String(e?.message || e);
  if (/fetch|network|Failed to fetch|HTTP/i.test(m)) return `モデルをダウンロードできません（${m}）`;
  return m;
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== "offscreen") return false;
  const handlers = {
    complete: () => serialize(() => complete(msg)).then((text) => ({ text })),
    status: () => status(),
    "delete-models": () => deleteModels().then(() => ({ ok: true })),
  };
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler().then(reply, (e) =>
    reply(e instanceof FatalError ? { error: e.message, fatal: true } : { error: errorText(e), fatal: false })
  );
  return true;
});

chrome.runtime.sendMessage({ type: "engine:ready" }).catch(() => {});
