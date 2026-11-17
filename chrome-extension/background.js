const SERVER_URL = "http://127.0.0.1:8802";
const STOP = ["<|plamo:tag|>", "<|plamo:bos|>"];
const MAX_CHARS = 8000;
const HISTORY_PAIRS = 3;
const HISTORY_MAX = 50;
// llama-server が 8 スロット以上で動いているときは、0〜3 を Claude Code の表示翻訳フック用とみなし、
// 拡張は 4〜7 に固定してフックの対訳履歴のキャッシュを追い出さないようにする
const EXT_SLOTS = [4, 5, 6, 7];
const SERVER_CHECK_INTERVAL_MS = 5000;
const DEFAULT_SETTINGS = { engine: "auto", form: "polite", autoStartServer: false };
const NATIVE_HOST = "jp.plamo_translate.server";
const AUTO_START_RETRY_MS = 5 * 60 * 1000;
const JA_CHAR = /[぀-ヿ㐀-鿿ｦ-ﾟ]/g;
const LATIN_CHAR = /[A-Za-z]/g;

let settings = { ...DEFAULT_SETTINGS };
const settingsLoaded = chrome.storage.local
  .get("settings")
  .then(({ settings: s }) => (settings = { ...DEFAULT_SETTINGS, ...s }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "plamo-translate", title: "PLaMo で翻訳", contexts: ["selection"] });
  chrome.contextMenus.create({ id: "plamo-page", title: "このページを PLaMo で翻訳", contexts: ["page"] });
  chrome.contextMenus.create({ id: "plamo-page-restore", title: "ページ翻訳を元に戻す", contexts: ["page"] });
  chrome.contextMenus.create({ id: "plamo-history", title: "PLaMo 翻訳の履歴", contexts: ["page"] });
  chrome.contextMenus.create({ id: "plamo-server-start", title: "翻訳サーバーを起動", contexts: ["page"] });
  chrome.contextMenus.create({ id: "plamo-server-stop", title: "翻訳サーバーを停止", contexts: ["page"] });
  chrome.contextMenus.create({ id: "plamo-settings", title: "PLaMo 翻訳の設定", contexts: ["page"] });
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id == null) return;
  const frameId = info.frameId ?? 0;
  if (info.menuItemId === "plamo-translate") run(tab.id, frameId, () => globalThis.__plamoTranslate?.translateSelection());
  if (info.menuItemId === "plamo-page") run(tab.id, frameId, () => globalThis.__plamoTranslate?.translatePage());
  if (info.menuItemId === "plamo-page-restore") run(tab.id, frameId, () => globalThis.__plamoTranslate?.restorePage());
  if (info.menuItemId === "plamo-history") run(tab.id, frameId, () => globalThis.__plamoTranslate?.showHistory());
  if (info.menuItemId === "plamo-settings") chrome.runtime.openOptionsPage();
  if (info.menuItemId === "plamo-server-start") startServer(tab.id);
  if (info.menuItemId === "plamo-server-stop") stopServer(tab.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id == null) return;
  if (command === "translate-selection") run(tab.id, null, () => globalThis.__plamoTranslate?.translateSelection());
  if (command === "translate-page") run(tab.id, 0, () => globalThis.__plamoTranslate?.togglePage());
});

chrome.tabs.onRemoved.addListener((tabId) => cancelQueued(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => change.status === "loading" && cancelQueued(tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  switch (msg?.type) {
    case "plamo:translate":
      if (tabId == null) return false;
      translateInto(tabId, sender.frameId ?? 0, msg.requestId, msg.text, msg.target || targetLang(msg.text), msg.context);
      return false;
    case "plamo:translate-block": {
      if (tabId == null) return false;
      const frameId = sender.frameId ?? 0;
      const onPartial =
        msg.blockId == null
          ? undefined
          : (text) =>
              chrome.tabs.sendMessage(tabId, { type: "plamo:block-partial", blockId: msg.blockId, text }, { frameId }).catch(() => {});
      enqueue(tabId, { text: msg.text, target: msg.target, history: [], context: msg.context, onPartial }).then(sendResponse);
      return true;
    }
    case "plamo:page-cancel":
      if (tabId != null) cancelQueued(tabId);
      return false;
    case "plamo:history:list":
      loadHistory().then(sendResponse);
      return true;
    case "plamo:history:clear":
      chrome.storage.local.set({ history: [] }).then(() => sendResponse([]));
      return true;
    case "plamo:engine-status":
      engineStatus().then(sendResponse);
      return true;
    case "plamo:native-status":
      queryNative().then(() => sendResponse({ state: native, text: nativeText() }));
      return true;
    case "plamo:server-start":
      startServer(null);
      return false;
    case "plamo:server-stop":
      stopServer(null);
      return false;
    case "plamo:model-update":
      updateModel();
      return false;
    case "plamo:delete-models":
      callOffscreen({ type: "delete-models" }).then(sendResponse, (e) => sendResponse({ error: String(e.message || e) }));
      return true;
    case "engine:ready":
      offscreenReadyResolve?.();
      return false;
    case "engine:progress":
      relayProgress(msg);
      return false;
    case "engine:partial":
      partialHandlers.get(msg.streamId)?.(msg.text);
      return false;
    default:
      return false;
  }
});

async function run(tabId, frameId, func) {
  const target = frameId == null ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
  try {
    // 拡張を入れる前から開いていたタブには content script が入っていないので、ここで入れる
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
    await chrome.scripting.executeScript({ target, func });
  } catch (e) {
    // chrome:// や Web ストア、PDF ビューアーなど、拡張がスクリプトを入れられないページでは何もしない
    console.warn("PLaMo 翻訳: このページでは使えません", e);
  }
}

function targetLang(text) {
  const ja = (text.match(JA_CHAR) || []).length;
  const latin = (text.match(LATIN_CHAR) || []).length;
  return ja + latin > 0 && ja / (ja + latin) >= 0.3 ? "en" : "ja";
}

async function translateInto(tabId, frameId, requestId, text, target, context) {
  const send = (payload) =>
    chrome.tabs.sendMessage(tabId, { type: "plamo:update", requestId, target, ...payload }, { frameId }).catch(() => {});
  if (text.length > MAX_CHARS) {
    send({ error: `選択範囲が長すぎます（${MAX_CHARS.toLocaleString()}文字まで）`, done: true });
    return;
  }
  const paragraphs = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  send({ paragraphs: paragraphs.length });

  // 段落を並列に訳すと前の段落を参照できず「They」などの指示語を取り違えるため、直前の段落を対訳履歴にして順に訳す
  const pairs = [];
  const outputs = [];
  for (const [index, paragraph] of paragraphs.entries()) {
    // 選択範囲の翻訳はユーザーが待っているので、ページ翻訳の段落より先に処理する
    const onPartial = (partial) => send({ index, partial });
    const res = await enqueue(tabId, { text: paragraph, target, history: pairs.slice(-HISTORY_PAIRS), context, onPartial }, true);
    if (res.cancelled) return;
    if (res.error) {
      send({ index, error: res.error });
      if (res.fatal) break;
      continue;
    }
    pairs.push([paragraph, res.text]);
    outputs[index] = res.text;
    send({ index, text: res.text });
  }
  send({ done: true });
  if (outputs.length) await saveHistory({ source: paragraphs.join("\n"), translation: outputs.filter(Boolean).join("\n"), target });
}

// 原文に PFML3 の特殊トークン表記があるとプロンプトの区切りと誤認されるので崩しておく
const escape = (text) => text.replaceAll("<|plamo:", "< |plamo:");

function buildPrompt({ text, target, history, context }) {
  // 文体は日本語に訳すときだけ指定できる。対訳履歴の output にも同じ指定を付け、訳文の文体をそろえる
  const form = target === "ja" && ["polite", "plain"].includes(settings.form) ? `<|plamo:key|>form<|plamo:val|>${settings.form}` : "";
  const output = `<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>${target}${form}<|plamo:msg|>`;
  let prompt = "<|plamo:tag|>dataset<|plamo:msg|>translation";
  if (context) prompt += `<|plamo:tag|>context<|plamo:msg|>${escape(context)}`;
  for (const [src, dst] of history) prompt += `<|plamo:tag|>input<|plamo:msg|>${escape(src)}${output}${escape(dst)}`;
  return prompt + `<|plamo:tag|>input<|plamo:msg|>${escape(text)}${output}`;
}

const maxTokensFor = (text) => Math.min(2048, Math.ceil(text.length * 1.5) + 64);

class EngineError extends Error {
  constructor(message, fatal) {
    super(message);
    this.fatal = fatal;
  }
}

const PARTIAL_INTERVAL_MS = 50;

async function completeOnServer(request, slot) {
  const stream = !!request.onPartial;
  let res;
  try {
    res = await fetch(`${SERVER_URL}/v1/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        prompt: buildPrompt(request),
        temperature: 0,
        max_tokens: maxTokensFor(request.text),
        stop: STOP,
        id_slot: slot,
        cache_prompt: true,
        stream,
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new EngineError("翻訳サーバー（127.0.0.1:8802）に接続できません", true);
  }
  if (res.status === 401) {
    // サーバーが再起動してキーが変わった。次の確認でキーを受け取り直す
    serverKey = null;
    serverState = { ...serverState, ok: false, checkedAt: 0 };
    throw new EngineError("翻訳サーバーの認証に失敗しました", true);
  }
  if (!res.ok) throw new EngineError(`翻訳サーバーがエラーを返しました（HTTP ${res.status}）`, false);
  if (!stream) return (await res.json()).choices[0].text.trim();

  // Server-Sent Events を読み、生成済みの訳文を一定間隔で途中経過として渡す
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";
  let lastSent = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      text += JSON.parse(data).choices?.[0]?.text ?? "";
      if (performance.now() - lastSent >= PARTIAL_INTERVAL_MS) {
        lastSent = performance.now();
        request.onPartial(text);
      }
    }
  }
  return text.trim();
}

const partialHandlers = new Map();
let streamSeq = 0;

async function completeInBrowser(request, model) {
  const streamId = request.onPartial ? ++streamSeq : null;
  if (streamId != null) partialHandlers.set(streamId, request.onPartial);
  try {
    const res = await callOffscreen({
      type: "complete",
      model,
      prompt: buildPrompt(request),
      maxTokens: maxTokensFor(request.text),
      streamId,
    });
    if (res?.error) throw new EngineError(res.error, !!res.fatal);
    return res.text;
  } finally {
    partialHandlers.delete(streamId);
  }
}

// ブラウザ内のモデルは同時に 1 件しか生成できないので 1 件ずつ、ローカルサーバーは最大 4 件並列に送る
const queue = [];
const freeServerSlots = [...EXT_SLOTS];
let browserBusy = false;
let runningServer = 0;
const waitingTabs = new Map();

let serverState = { ok: false, reserved: false, concurrency: 4, checkedAt: 0 };

// 同梱の起動プログラムが起動したサーバーは、起動ごとの API キーを必須にしている。キーはネイティブホストから受け取る
let serverKey = null;
const authHeaders = () => (serverKey ? { Authorization: `Bearer ${serverKey}` } : {});

const fetchProps = () => fetch(`${SERVER_URL}/props`, { headers: authHeaders(), signal: AbortSignal.timeout(1000) });

async function refreshServer(force = false) {
  if (!force && Date.now() - serverState.checkedAt < SERVER_CHECK_INTERVAL_MS) return serverState;
  try {
    const health = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(1000) });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
    let res = await fetchProps();
    if (res.status === 401 && native.installed !== false) {
      await queryNative();
      res = await fetchProps();
    }
    // キーを受け取れないサーバー（ほかの人が起動した、登録していない起動プログラムで起動した）は使わない
    if (res.status === 401) throw new Error("unauthorized");
    const props = await res.json().catch(() => ({}));
    const total = props.total_slots || 4;
    serverState = { ok: true, reserved: total >= 8, concurrency: Math.min(4, total), checkedAt: Date.now() };
  } catch {
    serverState = { ...serverState, ok: false, checkedAt: Date.now() };
  }
  return serverState;
}

// 「自動」は、ローカルサーバーが応答すればそれを、しなければブラウザ内の 0.8B を使う
function currentEngine() {
  if (settings.engine !== "auto") return settings.engine;
  return serverState.ok ? "server" : "browser-0.8b";
}

// 同梱の起動プログラムをネイティブホストとして呼び出し、翻訳サーバーを起動・停止する。
// ポートを開いている間だけサーバーが動き、ポートを閉じる（Chrome を終了する）とサーバーも止まる
let nativePort = null;
let keepNativePort = false;
let toastTab = null;
let lastAutoStart = 0;
const statusWaiters = [];
const native = {
  installed: null,
  running: false,
  managed: false,
  starting: false,
  updating: false,
  updateAvailable: false,
  progress: null,
  notice: "",
  error: "",
};

function nativeText() {
  if (native.installed === false) {
    return "翻訳サーバーが登録されていません。最初に1回、同梱の PLaMoTranslateServer.exe（Mac は start-server.command）を実行してください。";
  }
  if (native.error) return `翻訳サーバーを起動できませんでした: ${native.error}`;
  if (native.starting) {
    if (native.progress) {
      const pct = Math.floor((native.progress.loaded / native.progress.total) * 100);
      const size = (native.progress.total / 1e9).toFixed(1);
      return native.updating
        ? `翻訳モデルの新しい版（${size}GB）をダウンロード中… ${pct}%`
        : `翻訳サーバーを準備中（初回のみ ${size}GB をダウンロード）… ${pct}%`;
    }
    return native.notice || "翻訳サーバーを起動しています…";
  }
  if (native.running) return native.managed ? "翻訳サーバーを起動しました" : "翻訳サーバーは起動しています";
  return "翻訳サーバーは停止しています";
}

function publishNative() {
  chrome.runtime.sendMessage({ type: "plamo:native-state", state: native, text: nativeText() }).catch(() => {});
  if (toastTab != null) {
    const finished = !native.starting;
    chrome.tabs.sendMessage(toastTab, { type: "plamo:toast", text: nativeText(), sticky: !finished }).catch(() => {});
    if (finished) toastTab = null;
  }
}

function resolveStatusWaiters() {
  while (statusWaiters.length) statusWaiters.shift()();
}

function closeNativeIfIdle() {
  if (nativePort && !keepNativePort && !native.starting && !native.managed) {
    nativePort.disconnect();
    nativePort = null;
  }
}

function connectNative() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort = port;
  port.onMessage.addListener((m) => {
    native.installed = true;
    if (m.apiKey) serverKey = m.apiKey;
    switch (m.type) {
      case "status":
        Object.assign(native, {
          running: m.running,
          managed: m.managed,
          starting: m.starting,
          updateAvailable: !!m.updateAvailable,
        });
        if (!m.starting) Object.assign(native, { progress: null, updating: false });
        // 別に起動済みのサーバーがあった、停止し終えた、などで管理するサーバーがなければポートを閉じる
        if (!m.starting && !m.managed) keepNativePort = false;
        resolveStatusWaiters();
        break;
      case "progress":
        native.progress = { loaded: m.loaded, total: m.total };
        break;
      case "notice":
        native.notice = m.message;
        native.progress = null;
        break;
      case "started":
        Object.assign(native, { running: true, managed: true, starting: false, progress: null, error: "" });
        refreshServer(true).then(pump);
        break;
      case "error":
        Object.assign(native, { starting: false, progress: null, error: m.message });
        keepNativePort = false;
        break;
      case "exited":
        Object.assign(native, { running: false, managed: false });
        keepNativePort = false;
        refreshServer(true);
        break;
    }
    publishNative();
    closeNativeIfIdle();
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "";
    if (nativePort === port) nativePort = null;
    if (/not found|forbidden/i.test(error)) native.installed = false;
    Object.assign(native, { managed: false, starting: false, progress: null });
    keepNativePort = false;
    resolveStatusWaiters();
    refreshServer(true).then(() => {
      native.running = serverState.ok;
      publishNative();
    });
  });
  return port;
}

async function queryNative() {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    statusWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
    try {
      connectNative().postMessage({ type: "status" });
    } catch {
      native.installed = false;
      resolveStatusWaiters();
    }
  });
  closeNativeIfIdle();
}

function startServer(tabId) {
  toastTab = tabId ?? null;
  Object.assign(native, { error: "", notice: "", progress: null });
  keepNativePort = true;
  try {
    connectNative().postMessage({ type: "start" });
    native.starting = true;
  } catch {
    native.installed = false;
    keepNativePort = false;
  }
  publishNative();
}

// 翻訳モデルの新しい版を取得して差し替える。起動を確かめてから使い、起動できなければ元の版に戻す（起動プログラム側で行う）
function updateModel() {
  toastTab = null;
  Object.assign(native, { error: "", notice: "", progress: null, updating: true });
  keepNativePort = true;
  try {
    connectNative().postMessage({ type: "update" });
    native.starting = true;
  } catch {
    native.installed = false;
    Object.assign(native, { updating: false });
    keepNativePort = false;
  }
  publishNative();
}

function stopServer(tabId) {
  toastTab = tabId ?? null;
  keepNativePort = false;
  if (nativePort) {
    nativePort.postMessage({ type: "stop" });
  } else {
    publishNative();
  }
}

// 「自動」で翻訳サーバーが止まっていれば、設定に応じて翻訳を始めた時点で起動する（その間はブラウザ内で訳す）
function maybeAutoStart(tabId) {
  if (settings.engine !== "auto" || !settings.autoStartServer || serverState.ok) return;
  if (native.installed === false || native.starting || native.managed) return;
  if (Date.now() - lastAutoStart < AUTO_START_RETRY_MS) return;
  lastAutoStart = Date.now();
  startServer(tabId);
}

function enqueue(tabId, request, urgent = false) {
  waitingTabs.set(tabId, (waitingTabs.get(tabId) || 0) + 1);
  return new Promise((resolve) => {
    const done = (result) => {
      const left = (waitingTabs.get(tabId) || 1) - 1;
      if (left) waitingTabs.set(tabId, left);
      else waitingTabs.delete(tabId);
      resolve(result);
    };
    queue[urgent ? "unshift" : "push"]({ tabId, request, resolve: done });
    settingsLoaded
      .then(() => (settings.engine === "browser-0.8b" || settings.engine === "browser-2b" ? null : refreshServer()))
      .then(() => {
        maybeAutoStart(tabId);
        pump();
      });
  });
}

function pump() {
  while (queue.length) {
    const engine = currentEngine();
    let slot = -1;
    if (engine === "server") {
      if (runningServer >= serverState.concurrency) return;
      if (serverState.reserved) {
        if (!freeServerSlots.length) return;
        slot = freeServerSlots.shift();
      }
      runningServer++;
    } else {
      if (browserBusy) return;
      browserBusy = true;
    }
    const item = queue.shift();
    const job = engine === "server" ? completeOnServer(item.request, slot) : completeInBrowser(item.request, engine);
    job
      .then(
        (text) => item.resolve({ text }),
        (e) => {
          const fatal = e instanceof EngineError ? e.fatal : false;
          // 「自動」で使っていたサーバーが止まっていたら、ブラウザ内で訳し直す
          if (engine === "server" && settings.engine === "auto" && fatal) {
            serverState = { ...serverState, ok: false, checkedAt: Date.now() };
            queue.unshift(item);
            return;
          }
          item.resolve({ error: String(e.message || e), fatal });
        }
      )
      .finally(() => {
        if (engine === "server") {
          runningServer--;
          if (slot >= 0) freeServerSlots.push(slot);
        } else {
          browserBusy = false;
        }
        pump();
      });
  }
}

function cancelQueued(tabId) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].tabId === tabId) queue.splice(i, 1)[0].resolve({ cancelled: true });
  }
}

function relayProgress({ model, loaded, total }) {
  for (const tabId of waitingTabs.keys()) {
    chrome.tabs.sendMessage(tabId, { type: "plamo:engine-progress", model, loaded, total }).catch(() => {});
  }
}

let creatingOffscreen = null;
let offscreenReadyResolve = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = (async () => {
      const ready = new Promise((resolve) => {
        offscreenReadyResolve = resolve;
        setTimeout(resolve, 15000);
      });
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "翻訳モデルをブラウザ内で動かすため",
      });
      await ready;
    })().finally(() => (creatingOffscreen = null));
  }
  await creatingOffscreen;
}

async function callOffscreen(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", ...message });
}

async function engineStatus() {
  await settingsLoaded;
  const server = (await refreshServer(true)).ok;
  const base = { engine: settings.engine, active: currentEngine(), server };
  if (base.active === "server") return base;
  try {
    return { ...base, ...(await callOffscreen({ type: "status" })) };
  } catch (e) {
    return { ...base, error: String(e.message || e) };
  }
}

async function loadHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  return history;
}

async function saveHistory(entry) {
  const history = await loadHistory();
  const rest = history.filter((h) => !(h.source === entry.source && h.target === entry.target));
  await chrome.storage.local.set({ history: [{ ...entry, time: Date.now() }, ...rest].slice(0, HISTORY_MAX) });
}
