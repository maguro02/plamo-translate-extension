(() => {
  if (globalThis.__plamoTranslate) return;

  const LANG_LABEL = { ja: "日本語", en: "英語" };
  const STYLE = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    .trigger, .window, .status, .toast {
      --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --border: #d0d7de; --accent: #0969da;
      --on-accent: #ffffff; --pending: #eaeef2; --error: #cf222e; --hover: #f3f4f6;
      font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      .trigger, .window, .status, .toast {
        --bg: #1f2328; --fg: #e6edf3; --muted: #9198a1; --border: #3d444d; --accent: #4493f8;
        --on-accent: #0d1117; --pending: #2d333b; --error: #ff7b72; --hover: #2d333b;
      }
    }
    button {
      font: inherit; color: var(--muted); background: none; border: 0; border-radius: 6px;
      padding: 2px 8px; cursor: pointer; white-space: nowrap;
    }
    button:hover { background: var(--hover); color: var(--fg); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .trigger {
      position: fixed; width: 28px; height: 28px; padding: 0;
      font-size: 13px; font-weight: 700; line-height: 28px; text-align: center;
      color: var(--on-accent); background: var(--accent); border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    }
    .trigger:hover { color: var(--on-accent); background: var(--accent); filter: brightness(1.1); }
    .window {
      position: fixed; box-sizing: border-box; width: 400px; max-width: calc(100vw - 16px); max-height: 60vh;
      display: flex; flex-direction: column;
      color: var(--fg); background: var(--bg);
      border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.2);
    }
    .head {
      display: flex; align-items: center; gap: 2px; flex: none;
      padding: 6px 6px 6px 12px; border-bottom: 1px solid var(--border);
      font-size: 12px; color: var(--muted); cursor: move; user-select: none; touch-action: none;
    }
    .title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .source {
      flex: none; max-height: 30%; overflow-y: auto; padding: 8px 12px;
      font-size: 12px; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere;
      border-bottom: 1px solid var(--border);
    }
    .body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; }
    p { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
    p:last-child { margin-bottom: 0; }
    p.pending { height: 1.2em; border-radius: 4px; background: var(--pending); animation: pulse 1.2s ease-in-out infinite; }
    p.error { color: var(--error); }
    p.streaming::after { content: "▍"; margin-left: 1px; color: var(--muted); animation: pulse 1s ease-in-out infinite; }
    p.empty { color: var(--muted); }
    @keyframes pulse { 50% { opacity: 0.45; } }
    @media (prefers-reduced-motion: reduce) { p.pending { animation: none; } }
    .entry {
      display: block; width: 100%; box-sizing: border-box; padding: 6px 8px; text-align: left;
      color: var(--fg); white-space: normal;
    }
    .entry + .entry { border-top: 1px solid var(--border); border-radius: 0; }
    .entry .src, .entry .dst { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
    .entry .src { font-size: 12px; color: var(--muted); }
    .entry .time { font-size: 10px; color: var(--muted); }
    .foot {
      display: flex; align-items: center; justify-content: space-between; flex: none;
      padding: 0 6px 4px; font-size: 10px; color: var(--muted);
    }
    .foot .credit { margin-left: auto; padding-right: 6px; }
    .status {
      position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 2px;
      padding: 4px 4px 4px 12px; font-size: 12px; line-height: 1.6; color: var(--fg); background: var(--bg);
      border: 1px solid var(--border); border-radius: 999px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    }
    .status .msg { margin-right: 4px; white-space: nowrap; }
    .toast {
      position: fixed; left: 16px; bottom: 16px; max-width: min(420px, calc(100vw - 32px));
      padding: 8px 14px; font-size: 12px; line-height: 1.6; color: var(--fg); background: var(--bg);
      border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    }
  `;
  const TR_STYLE =
    "display:block;margin:.35em 0 0;padding:0 0 0 .6em;border-left:2px solid rgba(9,105,218,.55);" +
    "font:inherit;color:inherit;white-space:normal;text-align:start;";
  const REPLACE_STYLE = "display:inline;font:inherit;color:inherit;";
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "BUTTON",
    "PRE", "SVG", "MATH", "CANVAS", "IFRAME", "PLAMO-TR", "PLAMO-ORIG", "PLAMO-TRANSLATE",
  ]);
  // 文中のインラインコードは段落の一部として訳文に残したいので、ブロック表示のときだけ訳さない
  const CODE_TAGS = new Set(["CODE", "KBD", "SAMP", "VAR"]);
  const DEFAULT_SETTINGS = { pageMode: "bilingual", selectionButton: true };
  // 拡張が使う llama-server のスロット数（background.js の EXT_SLOTS）と同じにする
  const PAGE_INFLIGHT = 4;
  const HEADING = /^H[1-6]$/;
  const JA_CHAR = /[぀-ヿ㐀-鿿ｦ-ﾟ]/g;
  const LATIN_CHAR = /[A-Za-z]/g;
  const WINDOW_HTML = `
    <div class="head">
      <span class="title"></span>
      <button class="swap" type="button"></button>
      <button class="copy" type="button">コピー</button>
      <button class="toggle" type="button"></button>
      <button class="close" type="button" aria-label="閉じる">×</button>
    </div>
    <div class="source"></div>
    <div class="body" aria-live="polite"></div>
    <div class="foot">
      <button class="clear" type="button">履歴を消去</button>
      <span class="credit">Built with PLaMo</span>
    </div>`;

  let host = null;
  let root = null;
  let win = null;
  let trigger = null;
  let state = null;
  let view = "result";
  let historyList = [];
  let pointer = null;
  let pendingSelection = { text: "", context: "" };
  let status = null;
  let page = null;
  let engineProgress = null;
  let blockSeq = 0;
  const streamingBlocks = new Map();
  let settings = { ...DEFAULT_SETTINGS };

  chrome.storage.local.get("settings").then(({ settings: s }) => (settings = { ...DEFAULT_SETTINGS, ...s }));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    if (!settings.selectionButton) hideTrigger();
  });

  const trusted = (handler) => (e) => {
    if (e.isTrusted) handler(e);
  };
  let timings = null;

  const clamp = (v, min, max) => Math.min(Math.max(v, min), Math.max(min, max));

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement("plamo-translate");
    host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    // ページのスクリプトから中身（ほかのサイトの翻訳履歴を含む）を読めないよう closed にする
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${STYLE}</style>`;
    document.documentElement.appendChild(host);
    win = trigger = status = null;
  }

  function selectionInfo(withContext = true) {
    const el = document.activeElement;
    // テキスト欄の中の選択は getSelection() に現れないため、欄の値から切り出す
    if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|search|url)$/.test(el.type)))) {
      const text = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0).trim();
      return { text, rect: el.getBoundingClientRect(), context: withContext ? contextFor(text, el.value) : "" };
    }
    const sel = getSelection();
    const text = sel ? sel.toString().trim() : "";
    if (!withContext) return { text };
    const rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    const anchor = sel?.anchorNode;
    const anchorEl = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    const block = anchorEl && !isOurs(anchorEl) ? blockOf(anchorEl, new Map()) : null;
    return { text, rect, context: text ? contextFor(text, block && block !== document.body ? textOf(block) : "") : "" };
  }

  // 訳文を差し込んだ段落からも原文だけを読む
  function textOf(block) {
    const copy = block.cloneNode(true);
    for (const el of copy.querySelectorAll("plamo-tr")) el.remove();
    return copy.textContent.replace(/\s+/g, " ").trim();
  }

  function describePage() {
    const title = (document.title || "").trim().slice(0, 150);
    const site =
      document.querySelector('meta[property="og:site_name"]')?.content?.trim() || location.hostname.replace(/^www\./, "");
    if (title && site) return `Web page "${title}" on ${site}.`;
    if (title) return `Web page "${title}".`;
    return site ? `Web page on ${site}.` : "";
  }

  // 選択が段落の一部なら、段落全体を参考文脈に足して、指示語や用語の取り違えを減らす
  function contextFor(text, surrounding) {
    let context = describePage();
    if (surrounding && surrounding.length > text.length + 20) {
      context += ` Surrounding text: ${surrounding.slice(0, 600)}`;
    }
    return context.trim();
  }

  function showTrigger(x, y) {
    ensureHost();
    if (!trigger) {
      trigger = document.createElement("button");
      trigger.className = "trigger";
      trigger.type = "button";
      trigger.textContent = "訳";
      trigger.title = "PLaMo で翻訳";
      trigger.setAttribute("aria-label", "PLaMo で翻訳");
      // ボタンを押した瞬間にページの選択が解除されないようにする
      trigger.addEventListener("mousedown", (e) => e.preventDefault());
      trigger.addEventListener("click", trusted((e) => {
        const { text, context } = pendingSelection;
        hideTrigger();
        translate(text, e.clientX, e.clientY, undefined, context);
      }));
      root.appendChild(trigger);
    }
    trigger.style.left = `${clamp(x + 6, 4, innerWidth - 32)}px`;
    trigger.style.top = `${clamp(y + 10, 4, innerHeight - 32)}px`;
  }

  function hideTrigger() {
    trigger?.remove();
    trigger = null;
  }

  function ensureWindow(x, y) {
    ensureHost();
    if (win) return;
    win = document.createElement("div");
    win.className = "window";
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-label", "PLaMo 翻訳");
    win.innerHTML = WINDOW_HTML;
    const $ = (s) => win.querySelector(s);
    $(".close").addEventListener("click", trusted(closeWindow));
    $(".swap").addEventListener("click", trusted(() =>
      translate(state.text, 0, 0, state.target === "ja" ? "en" : "ja", state.context)
    ));
    $(".copy").addEventListener("click", trusted(copy));
    $(".toggle").addEventListener("click", trusted(() => (view === "history" ? ((view = "result"), render()) : showHistory())));
    $(".clear").addEventListener("click", trusted(async () => {
      historyList = (await chrome.runtime.sendMessage({ type: "plamo:history:clear" })) || [];
      render();
    }));
    enableDrag($(".head"));
    root.appendChild(win);
    win.style.left = `${x}px`;
    win.style.top = `${y + 12}px`;
  }

  function enableDrag(handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (!e.isTrusted || e.button !== 0 || e.target.closest("button")) return;
      e.preventDefault();
      const r = win.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        win.style.left = `${clamp(ev.clientX - dx, 0, innerWidth - win.offsetWidth)}px`;
        win.style.top = `${clamp(ev.clientY - dy, 0, innerHeight - handle.offsetHeight)}px`;
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });
  }

  function keepInView() {
    if (!win) return;
    const r = win.getBoundingClientRect();
    win.style.left = `${clamp(r.left, 8, innerWidth - r.width - 8)}px`;
    win.style.top = `${clamp(r.top, 8, innerHeight - r.height - 8)}px`;
  }

  function para(text, className) {
    const p = document.createElement("p");
    if (className) p.className = className;
    p.textContent = text;
    return p;
  }

  function entryButton(entry) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "entry";
    for (const [cls, text] of [
      ["src", entry.source],
      ["dst", entry.translation],
      ["time", new Date(entry.time).toLocaleString()],
    ]) {
      const div = document.createElement("div");
      div.className = cls;
      div.textContent = text;
      b.appendChild(div);
    }
    b.addEventListener("click", trusted(() => {
      state = {
        requestId: null,
        text: entry.source,
        target: entry.target,
        outputs: entry.translation.split("\n").map((text) => ({ text })),
        fromHistory: true,
      };
      view = "result";
      render();
    }));
    return b;
  }

  function render() {
    if (!win) return;
    const $ = (s) => win.querySelector(s);
    const inHistory = view === "history";
    $(".toggle").textContent = inHistory ? "戻る" : "履歴";
    $(".toggle").hidden = inHistory && !state;
    $(".swap").hidden = inHistory || !state?.target;
    $(".copy").hidden = inHistory || !state;
    $(".clear").hidden = !inHistory || !historyList.length;
    if (inHistory) {
      $(".title").textContent = "翻訳履歴";
      $(".source").hidden = true;
      $(".body").replaceChildren(...(historyList.length ? historyList.map(entryButton) : [para("履歴はありません", "empty")]));
    } else {
      const other = state.target === "ja" ? "en" : "ja";
      const waiting = state.outputs.some((o) => o == null);
      $(".title").textContent =
        waiting && engineProgress
          ? engineProgress
          : state.target
            ? `→ ${LANG_LABEL[state.target]}`
            : "翻訳中…";
      $(".swap").textContent = `${LANG_LABEL[other]}に訳す`;
      $(".source").hidden = !state.fromHistory;
      $(".source").textContent = state.fromHistory ? state.text : "";
      $(".body").replaceChildren(
        ...state.outputs.map((o) =>
          o == null
            ? para("", "pending")
            : o.error
              ? para(o.error, "error")
              : para(o.text, o.partial ? "streaming" : undefined)
        )
      );
    }
    requestAnimationFrame(keepInView);
  }

  function translate(text, x, y, target, context) {
    if (!text) return;
    ensureWindow(x, y);
    state = { requestId: crypto.randomUUID(), text, context, target: target ?? null, outputs: [null], fromHistory: false };
    timings = { start: performance.now(), first: null, done: null, updates: 0 };
    view = "result";
    render();
    chrome.runtime.sendMessage({ type: "plamo:translate", requestId: state.requestId, text, target, context });
  }

  function translateSelection() {
    const { text, rect, context } = selectionInfo();
    if (!text) return false;
    const at = pointer ?? (rect ? { x: rect.left, y: rect.bottom } : { x: 40, y: 40 });
    hideTrigger();
    translate(text, at.x, at.y, undefined, context);
    return true;
  }

  async function showHistory() {
    const at = pointer ?? { x: 40, y: 40 };
    ensureWindow(at.x, at.y);
    historyList = (await chrome.runtime.sendMessage({ type: "plamo:history:list" })) || [];
    view = "history";
    render();
  }

  function closeWindow() {
    win?.remove();
    win = null;
    state = null;
    view = "result";
  }

  async function copy() {
    const button = win.querySelector(".copy");
    const text = state.outputs.filter((o) => o && !o.error).map((o) => o.text).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "コピーしました";
    } catch {
      button.textContent = "コピーできません";
    }
    setTimeout(() => button.isConnected && (button.textContent = "コピー"), 1500);
  }

  const count = (text, re) => (text.match(re) || []).length;

  function isSkipped(el, cache) {
    if (!el || el === document.body) return false;
    if (cache.has(el)) return cache.get(el);
    const skip =
      SKIP_TAGS.has(el.tagName) ||
      (CODE_TAGS.has(el.tagName) && !getComputedStyle(el).display.startsWith("inline")) ||
      el.isContentEditable ||
      el.tagName === "NAV" ||
      el.getAttribute("role") === "navigation" ||
      el.getAttribute("aria-hidden") === "true" ||
      el.getAttribute("translate") === "no" ||
      el.classList.contains("notranslate") ||
      isSkipped(el.parentElement, cache);
    cache.set(el, skip);
    return skip;
  }

  function blockOf(el, cache) {
    if (cache.has(el)) return cache.get(el);
    const display = getComputedStyle(el).display;
    const block = el === document.body || (!display.startsWith("inline") && display !== "contents") ? el : blockOf(el.parentElement, cache);
    cache.set(el, block);
    return block;
  }

  function eligible(text, block) {
    const ja = count(text, JA_CHAR);
    const latin = count(text, LATIN_CHAR);
    // ナビゲーションやボタンの短い語にまで訳を付けると画面が崩れるので、見出し以外の短い文は訳さない
    if (page.target === "ja") {
      return latin >= 2 && ja / (ja + latin) < 0.3 && (HEADING.test(block.tagName) || text.split(/\s+/).length >= 3);
    }
    return ja >= 2 && ja / (ja + latin) >= 0.3 && (HEADING.test(block.tagName) || ja >= 6);
  }

  function collectBlocks() {
    if (!page) return;
    const skipCache = new Map();
    const blockCache = new Map();
    const owned = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !/\S/.test(node.data) || isSkipped(parent, skipCache)) continue;
      const block = blockOf(parent, blockCache);
      if (block === document.body || page.seen.has(block)) continue;
      if (!owned.has(block)) owned.set(block, []);
      owned.get(block).push(node.data);
    }
    for (const [block, parts] of owned) {
      page.seen.add(block);
      const text = parts.join("").replace(/\s+/g, " ").trim();
      if (!block.checkVisibility() || !eligible(text, block)) continue;
      // 「Skip to content」のような読み上げ専用の要素は 1px 程度に縮めて隠してあるので訳さない
      const rect = block.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      page.texts.set(block, text);
      page.observed++;
      const queue = block.closest("article")
        ? page.articleQueue
        : block.closest("main, [role=main]")
          ? page.mainQueue
          : page.otherQueue;
      queue.push(block);
      page.io.observe(block);
    }
    pumpPage();
  }

  // 画面に見えている段落、記事（article）、本文（main）、その他の順に、最大 PAGE_INFLIGHT 件ずつ送る。
  // GitHub のように main の中にファイル一覧などの UI と記事が並ぶページでも、記事を先に訳すため article を分けている
  function nextBlock() {
    for (const block of page.visible) {
      page.visible.delete(block);
      if (!page.started.has(block)) return block;
    }
    for (const queue of [page.articleQueue, page.mainQueue, page.otherQueue]) {
      while (queue.length) {
        const block = queue.shift();
        if (!page.started.has(block)) return block;
      }
    }
    return null;
  }

  function pumpPage() {
    const current = page;
    while (current && current === page && !current.failed && current.inflight < PAGE_INFLIGHT) {
      const block = nextBlock();
      if (!block) break;
      current.started.add(block);
      current.io.unobserve(block);
      current.inflight++;
      translateBlock(block).finally(() => {
        current.inflight--;
        if (current === page) {
          updateStatus();
          pumpPage();
        }
      });
    }
    updateStatus();
  }

  // 置き換え表示で隠す対象。段落の文として訳に含めた文字を持つ子だけを選び、画像やボタンなど訳に含めなかったものは残す
  function ownedChildren(block) {
    return [...block.childNodes].filter((n) => {
      if (n.nodeType === Node.TEXT_NODE) return true;
      if (n.nodeType !== Node.ELEMENT_NODE || isOurs(n) || !/\S/.test(n.textContent)) return false;
      return getComputedStyle(n).display.startsWith("inline") && !isSkipped(n, new Map());
    });
  }

  function replaceContent(block, translated, original) {
    const nodes = ownedChildren(block);
    if (!nodes.some((n) => /\S/.test(n.textContent))) return false;
    const tr = document.createElement("plamo-tr");
    tr.setAttribute("translate", "no");
    tr.className = "notranslate";
    tr.lang = page.target;
    tr.title = original;
    tr.style.cssText = REPLACE_STYLE;
    tr.textContent = translated;
    nodes[0].before(tr);
    for (const n of nodes) {
      const wrap = document.createElement("plamo-orig");
      wrap.style.cssText = "display:none !important;";
      n.replaceWith(wrap);
      wrap.append(n);
    }
    return true;
  }

  async function translateBlock(block) {
    const current = page;
    const text = current?.texts.get(block);
    if (!text || current.failed) return;
    const replace = current.mode === "replace";
    let tr = null;
    if (!replace) {
      tr = document.createElement("plamo-tr");
      tr.setAttribute("translate", "no");
      tr.className = "notranslate";
      tr.lang = current.target;
      tr.style.cssText = `${TR_STYLE}opacity:.45;`;
      tr.textContent = "…";
      block.appendChild(tr);
    }
    // 対訳表示では生成途中の訳文も表示する。置き換え表示は原文を早く消さないよう、訳し終えてから差し替える
    const blockId = tr ? ++blockSeq : null;
    if (tr) streamingBlocks.set(blockId, tr);
    const res = await chrome.runtime
      .sendMessage({ type: "plamo:translate-block", text, target: current.target, context: current.context, blockId })
      .catch(() => ({ error: "拡張との通信に失敗しました" }));
    streamingBlocks.delete(blockId);
    if (page !== current) return;
    if (res?.text && (replace ? replaceContent(block, res.text, text) : true)) {
      if (tr) {
        tr.style.cssText = TR_STYLE;
        tr.textContent = res.text;
      }
      current.done++;
    } else {
      tr?.remove();
      current.skipped++;
      if (res?.error) {
        current.error = res.error;
        // モデルを用意できない・サーバーに繋がらないまま全段落を送り続けないよう、以降の翻訳を止める
        if (res.fatal) {
          current.failed = true;
          current.io.disconnect();
        }
      }
    }
  }

  const isOurs = (node) =>
    ["PLAMO-TR", "PLAMO-ORIG", "PLAMO-TRANSLATE"].includes(node.nodeName) ||
    !!node.parentElement?.closest("plamo-tr, plamo-orig");

  function translatePage() {
    if (page) return;
    const sample = document.body.innerText.slice(0, 3000);
    const ja = count(sample, JA_CHAR);
    const latin = count(sample, LATIN_CHAR);
    page = {
      mode: settings.pageMode,
      target: ja + latin > 0 && ja / (ja + latin) >= 0.3 ? "en" : "ja",
      context: describePage(),
      seen: new WeakSet(),
      texts: new WeakMap(),
      started: new WeakSet(),
      visible: new Set(),
      articleQueue: [],
      mainQueue: [],
      otherQueue: [],
      observed: 0,
      inflight: 0,
      done: 0,
      skipped: 0,
      error: null,
      failed: false,
      timer: null,
    };
    // 画面に入った（入りそうな）段落を優先して訳すために見え方を追う。訳すのはページ全体
    page.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) page.visible.add(e.target);
          else page.visible.delete(e.target);
        }
        pumpPage();
      },
      { rootMargin: "200px 0px" }
    );
    page.mo = new MutationObserver((records) => {
      const external = records.some(
        (r) => !isOurs(r.target) && ![...r.addedNodes, ...r.removedNodes].every(isOurs)
      );
      if (!external) return;
      clearTimeout(page.timer);
      page.timer = setTimeout(collectBlocks, 800);
    });
    page.mo.observe(document.body, { childList: true, subtree: true });
    collectBlocks();
  }

  function restorePage() {
    if (!page) return;
    page.io.disconnect();
    page.mo.disconnect();
    clearTimeout(page.timer);
    page = null;
    for (const el of document.querySelectorAll("plamo-tr")) el.remove();
    for (const el of document.querySelectorAll("plamo-orig")) el.replaceWith(...el.childNodes);
    chrome.runtime.sendMessage({ type: "plamo:page-cancel" }).catch(() => {});
    updateStatus();
  }

  function togglePage() {
    if (page) restorePage();
    else translatePage();
  }

  function updateStatus() {
    if (!page) {
      status?.remove();
      status = null;
      return;
    }
    ensureHost();
    if (!status) {
      status = document.createElement("div");
      status.className = "status";
      status.setAttribute("role", "status");
      status.innerHTML =
        '<span class="msg"></span><button class="restore" type="button">元に戻す</button>' +
        '<button class="hide" type="button" aria-label="閉じる">×</button>';
      status.querySelector(".restore").addEventListener("click", trusted(restorePage));
      status.querySelector(".hide").addEventListener("click", trusted(() => (status.hidden = true)));
      root.appendChild(status);
    }
    const lang = LANG_LABEL[page.target];
    let msg;
    if (page.failed) msg = page.error;
    else if (!page.observed) msg = "訳す段落が見つかりません";
    else if (engineProgress && !page.done) msg = engineProgress;
    else if (page.inflight || page.done + page.skipped < page.observed) msg = `${lang}に翻訳中…（${page.done} / ${page.observed} 段落）`;
    else if (!page.done && page.error) msg = `翻訳できませんでした: ${page.error}`;
    else msg = `${lang}に翻訳済み · ${page.done} 段落`;
    status.querySelector(".msg").textContent = msg;
  }

  let toast = null;
  let toastTimer = null;

  // 翻訳サーバーの起動・停止の進み具合を、操作したタブの左下に出す
  function showToast(text, sticky) {
    ensureHost();
    if (!toast || !toast.isConnected) {
      toast = document.createElement("div");
      toast.className = "toast";
      toast.setAttribute("role", "status");
      root.appendChild(toast);
    }
    toast.textContent = text;
    clearTimeout(toastTimer);
    if (!sticky) {
      toastTimer = setTimeout(() => {
        toast?.remove();
        toast = null;
      }, 5000);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "plamo:toast") showToast(msg.text, msg.sticky);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "plamo:block-partial") return;
    const tr = streamingBlocks.get(msg.blockId);
    if (!tr || !msg.text.trim()) return;
    tr.style.cssText = TR_STYLE;
    tr.textContent = msg.text.trimStart();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "plamo:engine-progress") return;
    const pct = msg.total ? Math.floor((msg.loaded / msg.total) * 100) : 0;
    const size = msg.total ? `${(msg.total / 1e9).toFixed(1)}GB` : "";
    engineProgress = pct >= 100 ? null : `翻訳モデルを準備中（初回のみ ${size}）… ${pct}%`;
    if (win && view === "result" && state) render();
    updateStatus();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "plamo:update" || !state || msg.requestId !== state.requestId) return;
    state.target = msg.target;
    if (msg.paragraphs != null) state.outputs = Array.from({ length: msg.paragraphs }, () => null);
    if (msg.index != null) {
      if (msg.partial != null) {
        // 確定した訳文より後に途中経過が届いても上書きしない
        if (!state.outputs[msg.index] || state.outputs[msg.index].partial) {
          state.outputs[msg.index] = { text: msg.partial.trimStart(), partial: true };
        }
      } else {
        state.outputs[msg.index] = msg.error ? { error: msg.error } : { text: msg.text };
      }
    }
    if (msg.error && msg.index == null) state.outputs = [{ error: msg.error }];
    if (timings && state.requestId === msg.requestId) {
      timings.updates++;
      if (timings.first == null && state.outputs.some((o) => o?.text?.trim())) timings.first = performance.now();
      if (state.outputs.every((o) => o && !o.partial)) timings.done ??= performance.now();
    }
    if (view === "result") render();
  });

  document.addEventListener(
    "mouseup",
    (e) => {
      if (e.button !== 0) return;
      pointer = { x: e.clientX, y: e.clientY };
      if (!settings.selectionButton || (host && e.composedPath().includes(host))) return;
      // mouseup の時点ではダブルクリックなどの選択がまだ確定していないことがあるため、次のタスクで読む
      setTimeout(() => {
        pendingSelection = selectionInfo();
        if (pendingSelection.text) showTrigger(e.clientX, e.clientY);
        else hideTrigger();
      }, 0);
    },
    true
  );
  document.addEventListener("contextmenu", (e) => (pointer = { x: e.clientX, y: e.clientY }), true);
  document.addEventListener("mousedown", (e) => trigger && !e.composedPath().includes(trigger) && hideTrigger(), true);
  document.addEventListener("selectionchange", () => trigger && !selectionInfo(false).text && hideTrigger());
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      hideTrigger();
      closeWindow();
    },
    true
  );
  addEventListener("scroll", hideTrigger, { passive: true, capture: true });
  addEventListener("resize", keepInView);

  // content script の分離された環境にだけ置くので、ページのスクリプトからは呼べない（テストは chrome.scripting で呼ぶ）
  function inspect() {
    const t = timings;
    return {
      window: win
        ? {
            title: win.querySelector(".title").textContent,
            view,
            paragraphs: [...win.querySelectorAll(".body p")].map((p) => ({ cls: p.className, text: p.textContent })),
            entries: win.querySelectorAll(".entry").length,
          }
        : null,
      trigger: !!trigger,
      status: status && !status.hidden ? status.querySelector(".msg").textContent : null,
      toast: toast?.isConnected ? toast.textContent : null,
      timings: t && { firstMs: t.first && Math.round(t.first - t.start), doneMs: t.done && Math.round(t.done - t.start), updates: t.updates },
    };
  }

  globalThis.__plamoTranslate = { translateSelection, showHistory, translatePage, restorePage, togglePage, inspect };
})();
