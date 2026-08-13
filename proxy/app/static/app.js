"use strict";

/* ===== 会话与请求封装 ===== */
const TOKEN_KEY = "llm_gateway_master";
const getToken = () => sessionStorage.getItem(TOKEN_KEY);
const setToken = (v) => sessionStorage.setItem(TOKEN_KEY, v);
const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

async function api(path, opts = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (opts.withMaster !== false && getToken()) {
    headers["Authorization"] = "Bearer " + getToken();
  }
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401 && !opts._noLogout) {
    logout();
    throw new Error("未授权");
  }
  return res;
}

/* ===== Toast ===== */
let toastTimer = null;
function toast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show " + type;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; el.className = "toast"; }, 2600);
}

/* ===== 登录 ===== */
function showLogin() {
  document.getElementById("login-view").hidden = false;
  document.getElementById("app-view").hidden = true;
}
function showApp() {
  document.getElementById("login-view").hidden = true;
  document.getElementById("app-view").hidden = false;
  switchView("overview");
  refreshAll();
}
function logout() {
  clearToken();
  showLogin();
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = document.getElementById("login-key").value.trim();
  const errEl = document.getElementById("login-error");
  errEl.hidden = true;
  if (!key) { errEl.textContent = "请输入 MASTER_KEY"; errEl.hidden = false; return; }
  setToken(key);
  try {
    const res = await api("/admin/keys", { _noLogout: true });
    if (res.ok) {
      showApp();
    } else {
      clearToken();
      errEl.textContent = res.status === 401 ? "MASTER_KEY 无效" : ("登录失败 (" + res.status + ")");
      errEl.hidden = false;
    }
  } catch (err) {
    clearToken();
    errEl.textContent = "网络错误：" + err.message;
    errEl.hidden = false;
  }
});
document.getElementById("logout-btn").addEventListener("click", logout);

/* ===== 视图切换 ===== */
const TITLES = { overview: "概览", keys: "密钥管理", test: "调用测试" };
function switchView(name) {
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((el) => { el.hidden = true; });
  const v = document.getElementById("view-" + name);
  if (v) v.hidden = false;
  document.getElementById("page-title").textContent = TITLES[name] || "";
}
document.querySelectorAll(".nav-item[data-view]").forEach((el) => {
  el.addEventListener("click", (e) => { e.preventDefault(); switchView(el.dataset.view); });
});

/* ===== 工具 ===== */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(s) {
  if (!s) return "—";
  try {
    const d = new Date(s);
    if (isNaN(d)) return esc(s);
    return d.toLocaleString("zh-CN", { hour12: false });
  } catch { return esc(s); }
}
function badge(status) {
  const cls = status === "active" ? "badge-active" : "badge-revoked";
  const text = status === "active" ? "活跃" : "已吊销";
  return '<span class="badge ' + cls + '">' + text + "</span>";
}

/* ===== 数据加载 ===== */
let _keysCache = [];
async function loadKeys() {
  try {
    const res = await api("/admin/keys");
    if (!res.ok) throw new Error("加载失败");
    _keysCache = await res.json();
  } catch (e) { _keysCache = []; toast("密钥加载失败", "error"); }
  return _keysCache;
}

function renderOverview(keys) {
  const total = keys.length;
  const active = keys.filter((k) => k.status === "active").length;
  const revoked = total - active;
  const calls = keys.reduce((s, k) => s + (k.request_count || 0), 0);
  document.getElementById("stat-total").textContent = total;
  document.getElementById("stat-active").textContent = active;
  document.getElementById("stat-revoked").textContent = revoked;
  document.getElementById("stat-calls").textContent = calls;

  const tb = document.getElementById("overview-tbody");
  if (!keys.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">暂无密钥</td></tr>'; return; }
  tb.innerHTML = keys.slice(0, 5).map((k) =>
    "<tr><td>" + esc(k.key_prefix) + "</td><td>" + esc(k.name || "—") +
    "</td><td>" + badge(k.status) + "</td><td>" + (k.request_count || 0) +
    "</td><td>" + fmtTime(k.created_at) + "</td></tr>"
  ).join("");
}

function renderKeys(keys) {
  const tb = document.getElementById("keys-tbody");
  if (!keys.length) { tb.innerHTML = '<tr><td colspan="9" class="muted">暂无密钥，点击右上角新建</td></tr>'; return; }
  tb.innerHTML = keys.map((k) =>
    "<tr><td>" + k.id + "</td><td>" + esc(k.key_prefix) + "</td><td>" + esc(k.name || "—") +
    "</td><td>" + badge(k.status) + "</td><td>" + fmtTime(k.created_at) +
    "</td><td>" + fmtTime(k.expires_at) + "</td><td>" + fmtTime(k.last_used_at) +
    "</td><td>" + (k.request_count || 0) + "</td>" +
    '<td>' + (k.status === "active"
      ? '<button class="btn btn-danger btn-sm" data-revoke="' + k.id + '">吊销</button>'
      : '<span class="muted">—</span>') + "</td></tr>"
  ).join("");

  tb.querySelectorAll("[data-revoke]").forEach((btn) => {
    btn.addEventListener("click", () => revokeKey(parseInt(btn.dataset.revoke, 10)));
  });
}

async function refreshAll() {
  const keys = await loadKeys();
  renderOverview(keys);
  renderKeys(keys);
}

/* ===== 新建密钥 ===== */
function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }
document.querySelectorAll("[data-close]").forEach((el) => {
  el.addEventListener("click", () => {
    const m = el.closest(".modal");
    if (m) m.hidden = true;
  });
});
document.querySelectorAll(".modal-mask").forEach((el) => {
  el.addEventListener("click", () => { el.closest(".modal").hidden = true; });
});

document.getElementById("create-key-btn").addEventListener("click", () => {
  document.getElementById("create-name").value = "";
  document.getElementById("create-expires").value = "";
  openModal("modal-create");
});

document.getElementById("create-submit").addEventListener("click", async () => {
  const name = document.getElementById("create-name").value.trim() || null;
  let expires = document.getElementById("create-expires").value.trim() || null;
  if (expires) {
    const d = new Date(expires);
    if (isNaN(d)) { toast("过期时间格式无效", "error"); return; }
    expires = d.toISOString();
  }
  try {
    const res = await api("/admin/keys", {
      method: "POST",
      body: JSON.stringify({ name, expires_at: expires }),
    });
    if (!res.ok) { toast("创建失败 (" + res.status + ")", "error"); return; }
    const data = await res.json();
    closeModal("modal-create");
    document.getElementById("new-key-text").textContent = data.key;
    openModal("modal-key");
    refreshAll();
  } catch (e) { toast("创建失败：" + e.message, "error"); }
});

document.getElementById("copy-key").addEventListener("click", async () => {
  const txt = document.getElementById("new-key-text").textContent;
  try { await navigator.clipboard.writeText(txt); toast("已复制到剪贴板", "success"); }
  catch { toast("复制失败，请手动选择", "error"); }
});

async function revokeKey(id) {
  if (!confirm("确定吊销该密钥？吊销后无法恢复，使用该 key 的调用将立即失败。")) return;
  try {
    const res = await api("/admin/keys/" + id, { method: "DELETE" });
    if (res.ok) { toast("已吊销", "success"); refreshAll(); }
    else { toast("吊销失败 (" + res.status + ")", "error"); }
  } catch (e) { toast("吊销失败：" + e.message, "error"); }
}

/* ===== 调用测试控制台 ===== */
const outputEl = document.getElementById("test-output");
document.getElementById("test-clear").addEventListener("click", () => {
  outputEl.textContent = "点击「发送请求」查看结果。";
});

document.getElementById("test-send").addEventListener("click", async () => {
  const apiKey = document.getElementById("test-key").value.trim();
  const model = document.getElementById("test-model").value.trim();
  const prompt = document.getElementById("test-prompt").value;
  const temp = parseFloat(document.getElementById("test-temp").value) || 0.7;
  const stream = document.getElementById("test-stream").checked;

  if (!apiKey) { toast("请填入 API Key", "error"); return; }
  if (!model) { toast("请填入模型名", "error"); return; }
  if (!prompt) { toast("请输入 Prompt", "error"); return; }

  const payload = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: temp,
    stream,
  };
  outputEl.textContent = "";

  try {
    const res = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const t = await res.text();
      outputEl.textContent = "HTTP " + res.status + "\n" + t;
      return;
    }

    if (stream) {
      await readStream(res, outputEl);
    } else {
      const data = await res.json();
      const content = (data.choices && data.choices[0] && data.choices[0].message &&
        data.choices[0].message.content) || JSON.stringify(data, null, 2);
      outputEl.textContent = content;
    }
  } catch (e) {
    outputEl.textContent = "请求失败：" + e.message;
  }
});

async function readStream(res, el) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    done = d;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s || !s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
      if (data === "[DONE]") { el.textContent += "\n[完成]"; return; }
      try {
        const json = JSON.parse(data);
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (delta && delta.content) el.textContent += delta.content;
      } catch { /* 忽略非 JSON 心跳行 */ }
    }
  }
}

/* ===== 主题切换 ===== */
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  document.getElementById("theme-toggle").textContent = t === "light" ? "☀️" : "🌙";
}
document.getElementById("theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  const next = cur === "light" ? "dark" : "light";
  localStorage.setItem("llm_theme", next);
  applyTheme(next);
});
applyTheme(localStorage.getItem("llm_theme") || "dark");

/* ===== 启动 ===== */
if (getToken()) { showApp(); } else { showLogin(); }
