const DEFAULTS = { engine: "auto", form: "polite", pageMode: "bilingual", selectionButton: true, autoStartServer: false };
const MODEL_LABEL = { "browser-0.8b": "0.8B", "browser-2b": "2B" };
const $ = (s) => document.querySelector(s);

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULTS, ...settings };
  $(`input[name="engine"][value="${s.engine}"]`).checked = true;
  $(`input[name="form"][value="${s.form}"]`).checked = true;
  $(`input[name="pageMode"][value="${s.pageMode}"]`).checked = true;
  $('input[name="selectionButton"]').checked = s.selectionButton;
  $('input[name="autoStartServer"]').checked = s.autoStartServer;
}

async function save() {
  const settings = {
    engine: $('input[name="engine"]:checked').value,
    form: $('input[name="form"]:checked').value,
    pageMode: $('input[name="pageMode"]:checked').value,
    selectionButton: $('input[name="selectionButton"]').checked,
    autoStartServer: $('input[name="autoStartServer"]').checked,
  };
  await chrome.storage.local.set({ settings });
  $("#saved").textContent = "保存しました";
  setTimeout(() => ($("#saved").textContent = ""), 1500);
  refreshStatus();
}

async function refreshStatus() {
  const el = $("#engine-status");
  el.className = "";
  el.textContent = "状態を確認中…";
  const st = await chrome.runtime.sendMessage({ type: "plamo:engine-status" }).catch((e) => ({ error: e.message }));
  if (st?.active === "server") {
    if (st.server) {
      el.textContent = st.engine === "auto" ? "翻訳サーバーが起動しているので、翻訳サーバーで翻訳します。" : "翻訳サーバーに接続できます。";
    } else {
      el.textContent = "翻訳サーバー（127.0.0.1:8802）に接続できません。サーバーを起動してください。";
      el.className = "warn";
    }
  } else if (st?.error) {
    el.textContent = `状態を取得できません: ${st.error}`;
    el.className = "warn";
  } else if (st) {
    const parts = [];
    if (st.engine === "auto") parts.push("翻訳サーバーが起動していないので、ブラウザ内で翻訳します。");
    parts.push(st.webgpu ? "GPU（WebGPU）で動作します。" : "WebGPU を使えないため CPU で動作します（翻訳が遅くなります）。");
    const cached = Object.entries(st.cached || {}).filter(([, v]) => v).map(([k]) => MODEL_LABEL[k]);
    parts.push(cached.length ? `ダウンロード済み: ${cached.join("・")}` : "モデルはまだダウンロードしていません（最初の翻訳時に自動で取得します）。");
    el.textContent = parts.join(" ");
    if (!st.webgpu) el.className = "warn";
    $("#cache-size").textContent = st.cacheBytes ? `使用容量: ${(st.cacheBytes / 1e9).toFixed(2)}GB` : "";
    $("#delete-models").disabled = !st.cacheBytes;
  }
}

$("#delete-models").addEventListener("click", async () => {
  $("#delete-models").disabled = true;
  await chrome.runtime.sendMessage({ type: "plamo:delete-models" }).catch(() => {});
  refreshStatus();
});

function renderServer({ state, text }) {
  const el = $("#server-status");
  el.textContent = text;
  el.className = state.installed === false || state.error ? "warn" : "";
  $("#server-start").disabled = state.installed === false || state.running || state.starting;
  $("#server-stop").disabled = !state.managed && !state.starting;
  $("#model-update-row").hidden = !state.updateAvailable || state.starting;
}

$("#server-start").addEventListener("click", () => chrome.runtime.sendMessage({ type: "plamo:server-start" }));
$("#server-stop").addEventListener("click", () => chrome.runtime.sendMessage({ type: "plamo:server-stop" }));
$("#model-update").addEventListener("click", () => chrome.runtime.sendMessage({ type: "plamo:model-update" }));
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "plamo:native-state") return;
  renderServer(msg);
  if (!msg.state.starting) refreshStatus();
});

document.addEventListener("change", save);
load().then(() => {
  refreshStatus();
  chrome.runtime.sendMessage({ type: "plamo:native-status" }).then(renderServer).catch(() => {});
});
