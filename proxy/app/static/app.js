"use strict";

/* ===== 会话与请求封装 ===== */
const TOKEN_KEY = "ai_gateway_token";
const USER_KEY = "ai_gateway_user";
const getToken = () => sessionStorage.getItem(TOKEN_KEY);
const setToken = (v) => sessionStorage.setItem(TOKEN_KEY, v);
const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);
const getCurrentUser = () => {
  try { return JSON.parse(sessionStorage.getItem(USER_KEY) || "null"); }
  catch { return null; }
};
const setCurrentUser = (u) => sessionStorage.setItem(USER_KEY, JSON.stringify(u));
const clearCurrentUser = () => sessionStorage.removeItem(USER_KEY);
const isAdmin = () => getCurrentUser()?.role === "admin";

async function api(path, opts = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (opts.withAuth !== false && getToken()) {
    headers["Authorization"] = "Bearer " + getToken();
  }
  // 默认绕过浏览器 HTTP 缓存，避免读到陈旧的列表/reveal 响应（服务端 no-store 为双保险）
  const fetchOpts = Object.assign({ cache: "no-store" }, opts, { headers });
  const res = await fetch(path, fetchOpts);
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
  applyRoleVisibility();
  refreshUserInfo();
  switchView("overview");
  refreshAll();
}
function logout() {
  clearToken();
  clearCurrentUser();
  showLogin();
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.hidden = true;
  if (!username) { errEl.textContent = "请输入用户名"; errEl.hidden = false; return; }
  if (!password) { errEl.textContent = "请输入密码"; errEl.hidden = false; return; }
  try {
    const res = await fetch("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      const data = await res.json();
      setToken(data.access_token);
      if (data.user) setCurrentUser(data.user);
      showApp();
    } else {
      const errData = await res.json().catch(() => ({}));
      errEl.textContent = errData.detail || ("登录失败 (" + res.status + ")");
      errEl.hidden = false;
    }
  } catch (err) {
    errEl.textContent = "网络错误：" + err.message;
    errEl.hidden = false;
  }
});
document.getElementById("logout-btn").addEventListener("click", logout);

/* ===== 清除浏览器缓存并刷新 ===== */
document.getElementById("clear-cache-btn").addEventListener("click", async function () {
  const btn = this;
  btn.disabled = true;
  btn.textContent = "清理中…";
  try {
    // 清掉页面注册的 CacheStorage（若有）
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) { /* CacheStorage 不可用则跳过 */ }
  // api() 已默认 no-store，HTTP 缓存不会被读取；reload 会重新校验文档与带版本号的静态资源
  try { sessionStorage.setItem("cache_cleared_toast", "1"); } catch (e) { /* 忽略 */ }
  location.reload();
});
if (sessionStorage.getItem("cache_cleared_toast") === "1") {
  try { sessionStorage.removeItem("cache_cleared_toast"); } catch (e) { /* 忽略 */ }
  toast("浏览器缓存已清理", "success");
}

/* ===== 权限控制 ===== */
function applyRoleVisibility() {
  const adminOnly = document.querySelectorAll(".admin-only");
  adminOnly.forEach((el) => {
    if (isAdmin()) {
      el.style.display = "";
    } else {
      el.style.display = "none";
    }
  });
}

function refreshUserInfo() {
  const user = getCurrentUser();
  if (!user) return;
  document.getElementById("user-name").textContent = user.username;
  document.getElementById("user-role").textContent = user.role === "admin" ? "管理员" : "查看者";
  document.getElementById("user-avatar").textContent = user.username.charAt(0).toUpperCase();
}

/* ===== 视图切换 ===== */
const TITLES = {
  overview: "概览",
  stats: "用量统计",
  keys: "密钥管理",
  upstreams: "上游管理",
  users: "用户管理",
  chat: "对话",
};
function switchView(name) {
  if ((name === "users" || name === "upstreams") && !isAdmin()) {
    toast("权限不足", "error");
    name = "overview";
  }
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((el) => { el.hidden = true; });
  const v = document.getElementById("view-" + name);
  if (v) v.hidden = false;
  document.getElementById("page-title").textContent = TITLES[name] || "";

  if (name === "stats") loadStats();
  if (name === "users") loadUsers();
  if (name === "upstreams") loadUpstreams();
  if (name === "chat") {
    loadChatKeys();
    ensureUpstreams().then(fillChatModelDefault);
  }
}
document.querySelectorAll(".nav-item[data-view]").forEach((el) => {
  el.addEventListener("click", (e) => { e.preventDefault(); switchView(el.dataset.view); });
});

/* ===== 工具函数 ===== */
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
function fmtDate(s) {
  if (!s) return esc(s);
  return s;
}
function badge(status) {
  const cls = status === "active" ? "badge-active" : "badge-revoked";
  const text = status === "active" ? "活跃" : "已吊销";
  return '<span class="badge ' + cls + '">' + text + "</span>";
}
function roleBadge(role) {
  if (role === "admin") {
    return '<span class="badge" style="background: rgba(99,102,241,.15); color: var(--primary);">管理员</span>';
  }
  return '<span class="badge" style="background: rgba(148,163,184,.15); color: var(--text-dim);">查看者</span>';
}

/* ===== 概览数据 ===== */
let _upstreamsCache = [];

async function loadUpstreams() {
  try {
    const res = await api("/admin/upstreams");
    if (!res.ok) throw new Error("加载失败");
    const data = await res.json();
    _upstreamsCache = data;
    renderUpstreams(data);
    updateChatModelList();
    return data;
  } catch (e) { return []; }
}

/* ===== 对话测试页 模型下拉（自定义 Combobox） =====
 * 候选 = 所有上游配置的模型名（去重保序），当前选中密钥所属上游的模型排在最前。
 * 原生 input+datalist 在输入框已有值时会把候选过滤到只剩前缀匹配的 1 项，
 * 导致"配了多个模型却只能看到一个"，因此改成自绘下拉：点开显示全部候选、可输入过滤、选中即填入。
 */
let _chatModelOptions = [];  // 当前上下文可选模型（去重保序；选中密钥=其所属上游的模型，未选=全部）
let _chatModelOpen = false;  // 菜单是否展开
let _chatModelHl = -1;       // 键盘高亮项索引

function collectChatModels(keyId) {
  const seen = new Set();
  const out = [];
  // 选中了密钥 → 只取该密钥所属上游的模型（发请求走的是这个上游，其它上游模型无意义）
  let ups = _upstreamsCache || [];
  if (keyId) {
    const up = upstreamOfKey(keyId);
    ups = up ? [up] : [];
  }
  ups.forEach((u) => {
    (u.models || []).forEach((m) => {
      const name = String(m == null ? "" : m).trim();
      if (name && !seen.has(name)) { seen.add(name); out.push(name); }
    });
  });
  return out;
}
function currentChatKeyId() {
  const sel = document.getElementById("chat-key");
  const v = sel ? parseInt(sel.value, 10) : NaN;
  return Number.isNaN(v) ? 0 : v;
}
function updateChatModelList() {
  _chatModelOptions = collectChatModels(currentChatKeyId());
  if (_chatModelOpen) modelMenuRender(false);
}
function currentChatUpstream() {
  return upstreamOfKey(currentChatKeyId());
}
function modelMenuRender(filterByInput = true) {
  const menu = document.getElementById("chat-model-menu");
  if (!menu) return;
  const input = document.getElementById("chat-model");
  const cur = (input && input.value || "").trim();
  const q = cur.toLowerCase();
  // 当前密钥所属上游的模型优先展示
  const up = currentChatUpstream();
  const pref = new Set(((up && up.models) || []).map((m) => String(m == null ? "" : m).trim()).filter(Boolean));
  const ordered = _chatModelOptions.slice().sort((a, b) => ((pref.has(a) ? 0 : 1) - (pref.has(b) ? 0 : 1)));
  // filterByInput=false（菜单打开时）：显示全部候选，不因输入框已有值被过滤；
  // 只有用户键入时（input 事件）才按输入值过滤
  const list = (filterByInput && q) ? ordered.filter((n) => n.toLowerCase().includes(q)) : ordered;

  menu.replaceChildren();
  if (!_chatModelOptions.length) {
    const p = document.createElement("div");
    p.className = "model-menu-empty";
    const selected = Boolean(currentChatKeyId());
    p.textContent = selected
      ? "当前密钥所属上游未配置模型，可到上游管理添加，或直接输入模型名"
      : "暂无可选模型：在上游管理中配置模型后即会出现在这里，也可以直接输入模型名";
    menu.appendChild(p);
  } else if (!list.length) {
    const p = document.createElement("div");
    p.className = "model-menu-empty";
    p.textContent = "无匹配模型，可继续手动输入";
    menu.appendChild(p);
  } else {
    list.forEach((name) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "model-menu-item" + (name === cur ? " sel" : "");
      b.textContent = name;
      b.dataset.model = name;
      b.addEventListener("mousedown", (ev) => { ev.preventDefault(); pickChatModel(name); });
      menu.appendChild(b);
    });
  }
  _chatModelHl = -1;
}
function modelMenuOpen() {
  if (_chatModelOpen) return;
  _chatModelOpen = true;
  modelMenuRender(false);  // 打开时展示全部候选，不按输入框现值过滤
  const menu = document.getElementById("chat-model-menu");
  if (menu) menu.hidden = false;
}
function modelMenuClose() {
  _chatModelOpen = false;
  const menu = document.getElementById("chat-model-menu");
  if (menu) menu.hidden = true;
}
function modelMenuMove(dir) {
  modelMenuOpen();
  const menu = document.getElementById("chat-model-menu");
  if (!menu) return;
  const items = Array.from(menu.querySelectorAll(".model-menu-item"));
  if (!items.length) return;
  let i = _chatModelHl;
  i = dir > 0 ? (i < 0 ? 0 : (i + 1) % items.length)
    : (i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length);
  items.forEach((b, j) => b.classList.toggle("hl", j === i));
  _chatModelHl = i;
  const el = items[i];
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
}
function pickChatModel(name) {
  const input = document.getElementById("chat-model");
  if (input) {
    input.value = name;
    _chatAutoModel = "";  // 手动选定后不随后续密钥切换被自动覆盖
  }
  modelMenuClose();
}

async function ensureUpstreams() {
  if (!_upstreamsCache.length) await loadUpstreams();
  return _upstreamsCache;
}

// 对话页进入/密钥切换时，若尚未输入模型则优先用默认上游配置的第一个模型
function chatFirstSuggestedModel() {
  const ups = _upstreamsCache || [];
  if (!ups.length) return "";
  const ordered = ups.slice().sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0));
  for (const u of ordered) {
    for (const m of (u.models || [])) {
      const name = String(m == null ? "" : m).trim();
      if (name) return name;
    }
  }
  return "";
}
function fillChatModelDefault() {
  const el = document.getElementById("chat-model");
  if (!el || el.value) return;
  const first = chatFirstSuggestedModel();
  if (first) { el.value = first; _chatAutoModel = first; }
  if (_chatModelOpen) modelMenuRender(false);
}
function applyUpstreamModelsToChat(keyId) {
  // 按密钥绑定的上游模型刷新模型输入：
  // 输入为空，或仍等于上次自动填充值时随上游切换刷新；手动输入不覆盖。
  const el = document.getElementById("chat-model");
  if (!el) return;
  if (el.value && el.value !== _chatAutoModel) return;
  const up = upstreamOfKey(keyId);
  const list = ((up && up.models) || []).map((m) => String(m == null ? "" : m).trim()).filter(Boolean);
  if (list.length) {
    el.value = list[0];
    _chatAutoModel = list[0];
  } else {
    el.value = "";
    _chatAutoModel = "";
  }
  if (_chatModelOpen) modelMenuRender(false);
}
function upstreamOfKey(keyId) {
  const k = (_chatKeysCache || []).find((x) => x.id === keyId);
  if (k && k.upstream_id) {
    const up = (_upstreamsCache || []).find((u) => u.id === k.upstream_id);
    if (up) return up;
  }
  return (_upstreamsCache || []).find((u) => u.is_default) || null;
}

function getUpstreamName(id) {
  if (!id) return "默认";
  const up = _upstreamsCache.find((u) => u.id === id);
  return up ? up.name : "未知";
}

async function loadOverview() {
  try {
    const res = await api("/admin/stats/overview");
    if (!res.ok) throw new Error("加载失败");
    const data = await res.json();
    document.getElementById("stat-total").textContent = data.total_keys;
    document.getElementById("stat-active").textContent = data.active_keys;
    document.getElementById("stat-users").textContent = data.total_users;
    document.getElementById("stat-today").textContent = data.today_calls;
    document.getElementById("stat-calls").textContent = data.total_calls;
  } catch (e) {
    console.error(e);
  }
}

let _keysCache = [];
async function loadKeys() {
  try {
    const res = await api("/admin/keys");
    if (!res.ok) throw new Error("加载失败");
    return await res.json();
  } catch (e) { return []; }
}

function renderOverview(keys) {
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
  const admin = isAdmin();
  _keysCache = keys;
  if (!keys.length) {
    const cols = admin ? 10 : 9;
    tb.innerHTML = '<tr><td colspan="' + cols + '" class="muted">暂无密钥</td></tr>';
    return;
  }
  tb.innerHTML = keys.map((k) => {
    let html = "<tr><td>" + k.id + "</td><td>" + esc(k.key_prefix) + "</td><td>" + esc(k.name || "—") +
      "</td><td>" + esc(getUpstreamName(k.upstream_id)) + "</td><td>" + badge(k.status) + "</td><td>" + fmtTime(k.created_at) +
      "</td><td>" + fmtTime(k.expires_at) + "</td><td>" + fmtTime(k.last_used_at) +
      "</td><td>" + (k.request_count || 0) + "</td>";
    if (admin) {
      html += '<td>' +
        '<button class="btn btn-ghost btn-sm" data-edit-key="' + k.id + '" title="修改备注名称">编辑</button>' +
        (k.status === "active"
          ? '<button class="btn btn-ghost btn-sm" data-reset="' + k.id + '" title="生成新密钥替换旧值，旧 key 立即失效">重置</button>' +
            '<button class="btn btn-danger btn-sm" data-revoke="' + k.id + '">吊销</button>'
          : "") + "</td>";
    }
    html += "</tr>";
    return html;
  }).join("");

  tb.querySelectorAll("[data-edit-key]").forEach((btn) => {
    btn.addEventListener("click", () => openRenameKey(parseInt(btn.dataset.editKey, 10)));
  });
  tb.querySelectorAll("[data-reset]").forEach((btn) => {
    btn.addEventListener("click", () => resetKey(parseInt(btn.dataset.reset, 10)));
  });
  tb.querySelectorAll("[data-revoke]").forEach((btn) => {
    btn.addEventListener("click", () => revokeKey(parseInt(btn.dataset.revoke, 10)));
  });
}

async function refreshAll() {
  await loadOverview();
  if (isAdmin()) await loadUpstreams();
  const keys = await loadKeys();
  renderOverview(keys);
  renderKeys(keys);
}

/* ===== 新建/重置/吊销密钥 ===== */
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

document.getElementById("create-key-btn").addEventListener("click", async () => {
  document.getElementById("create-name").value = "";
  document.getElementById("create-expires").value = "";
  const sel = document.getElementById("create-upstream");
  sel.innerHTML = '<option value="">默认上游</option>';
  _upstreamsCache.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = u.name + (u.is_default ? " (默认)" : "");
    sel.appendChild(opt);
  });
  openModal("modal-create");
});

document.getElementById("create-submit").addEventListener("click", async () => {
  const name = document.getElementById("create-name").value.trim() || null;
  let expires = document.getElementById("create-expires").value.trim() || null;
  const upstreamId = document.getElementById("create-upstream").value;
  if (expires) {
    // datetime-local 的 value 形如 "2026-12-31T23:59"，补秒后按本地时区解析再转 UTC 存储
    const d = new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(expires) ? expires + ":00" : expires);
    if (isNaN(d)) { toast("过期时间格式无效", "error"); return; }
    expires = d.toISOString();
  }
  try {
    const body = { name, expires_at: expires };
    if (upstreamId) body.upstream_id = parseInt(upstreamId, 10);
    const res = await api("/admin/keys", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 403) { toast("权限不足", "error"); return; }
      toast("创建失败 (" + res.status + ")", "error"); return;
    }
    const data = await res.json();
    closeModal("modal-create");
    showPlainKeyModal(data.key || "", "create");
    refreshAll();
  } catch (e) { toast("创建失败：" + e.message, "error"); }
});

document.getElementById("copy-key").addEventListener("click", async () => {
  const txt = document.getElementById("new-key-text").textContent;
  try { await navigator.clipboard.writeText(txt); toast("已复制到剪贴板", "success"); }
  catch { toast("复制失败，请手动选择", "error"); }
});

/* 在"密钥已生成 / 已重置"弹窗中展示明文 key（仅显示一次，供立即复制保存） */
function showPlainKeyModal(keyText, mode) {
  const isReset = mode === "reset";
  document.getElementById("modal-key-title").textContent = isReset ? "密钥已重置" : "密钥已生成";
  document.getElementById("modal-key-warn").textContent = isReset
    ? "旧密钥已立即失效（即使泄露也无法再使用）。新密钥仅显示一次，请立即复制保存。"
    : "请立即复制保存，此明文密钥仅显示一次，丢失后需重新生成。";
  const keyEl = document.getElementById("new-key-text");
  keyEl.textContent = keyText || "";
  keyEl.style.color = "";
  if (!keyText) {
    keyEl.textContent = "⚠ 未获取到明文密钥，请刷新页面后重试";
    keyEl.style.color = "var(--danger)";
  }
  openModal("modal-key");
}

async function resetKey(id) {
  if (!confirm("确定重置该密钥？\n\n将生成一把新密钥替换当前密钥：\n· 旧 key 立即失效，即使已泄露也无法再使用；\n· 密钥名称 / 绑定上游 / 调用统计保持不变；\n· 新密钥仅显示一次，请准备好保存。")) return;
  try {
    const res = await api("/admin/keys/" + id + "/reset", { method: "POST" });
    if (!res.ok) {
      if (res.status === 403) { toast("权限不足", "error"); return; }
      const err = await res.json().catch(() => ({}));
      toast(err.detail || ("重置失败 (" + res.status + ")"), "error");
      return;
    }
    const data = await res.json();
    showPlainKeyModal(data.key || "", "reset");
    refreshAll();
  } catch (e) { toast("重置失败：" + e.message, "error"); }
}

async function revokeKey(id) {
  if (!confirm("确定吊销该密钥？吊销后无法恢复，使用该 key 的调用将立即失败。")) return;
  try {
    const res = await api("/admin/keys/" + id, { method: "DELETE" });
    if (res.ok) { toast("已吊销", "success"); refreshAll(); }
    else if (res.status === 403) { toast("权限不足", "error"); }
    else { toast("吊销失败 (" + res.status + ")", "error"); }
  } catch (e) { toast("吊销失败：" + e.message, "error"); }
}

/* ===== 编辑密钥名称 ===== */
function openRenameKey(id) {
  const k = _keysCache.find((x) => x.id === id);
  if (!k) return;
  document.getElementById("key-rename-id").value = k.id;
  document.getElementById("key-rename-name").value = k.name || "";
  document.getElementById("key-rename-prefix").textContent = k.key_prefix;
  openModal("modal-key-rename");
}

document.getElementById("key-rename-submit").addEventListener("click", async () => {
  const id = parseInt(document.getElementById("key-rename-id").value, 10);
  if (!id) return;
  const raw = document.getElementById("key-rename-name").value;
  const name = raw.trim() === "" ? null : raw.trim();
  try {
    const res = await api("/admin/keys/" + id, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      if (res.status === 403) { toast("权限不足", "error"); return; }
      const err = await res.json().catch(() => ({}));
      toast(err.detail || ("保存失败 (" + res.status + ")"), "error");
      return;
    }
    closeModal("modal-key-rename");
    toast("名称已更新", "success");
    refreshAll();
  } catch (e) { toast("保存失败：" + e.message, "error"); }
});

/* ===== 用量统计 ===== */
let _statsCache = null;
async function loadStats() {
  const days = parseInt(document.getElementById("trend-days").value, 10) || 7;
  const top = parseInt(document.getElementById("rank-top").value, 10) || 10;
  try {
    const res = await api("/admin/stats/usage?days=" + days + "&top=" + top);
    if (!res.ok) throw new Error("加载失败");
    const data = await res.json();
    _statsCache = data;
    renderTrendChart(data.trend);
    renderRankBars(data.by_key);
  } catch (e) {
    document.getElementById("trend-chart").innerHTML = "";
    document.getElementById("rank-bars").innerHTML = '<div class="muted">加载失败</div>';
  }
}

document.getElementById("trend-days").addEventListener("change", loadStats);
document.getElementById("rank-top").addEventListener("change", loadStats);

function renderTrendChart(trend) {
  const svg = document.getElementById("trend-chart");
  const W = 600, H = 240;
  const padL = 40, padR = 20, padT = 20, padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  if (!trend || !trend.length) {
    svg.innerHTML = '<text x="' + (W / 2) + '" y="' + (H / 2) +
      '" text-anchor="middle" fill="var(--text-mute)" font-size="13">暂无数据</text>';
    return;
  }

  const maxCount = Math.max(...trend.map((d) => d.count), 1);
  const n = trend.length;
  const stepX = n > 1 ? chartW / (n - 1) : chartW;

  let points = "";
  let areaPoints = "";
  let xLabels = "";
  let gridLines = "";

  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const y = padT + (chartH / ySteps) * i;
    const val = Math.round(maxCount * (1 - i / ySteps));
    gridLines += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y +
      '" stroke="var(--border)" stroke-width="1" stroke-dasharray="3,3"/>';
    gridLines += '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" ' +
      'fill="var(--text-mute)" font-size="11">' + val + '</text>';
  }

  trend.forEach((d, i) => {
    const x = padL + (n > 1 ? stepX * i : chartW / 2);
    const y = padT + chartH - (d.count / maxCount) * chartH;
    points += (i === 0 ? "" : ",") + x + "," + y;
    if (i === 0) areaPoints += x + "," + (padT + chartH) + " ";
    areaPoints += x + "," + y + " ";
    if (i === n - 1) areaPoints += x + "," + (padT + chartH);

    if (n <= 14 || i % Math.ceil(n / 10) === 0 || i === n - 1) {
      const label = d.date.slice(5);
      xLabels += '<text x="' + x + '" y="' + (H - 10) + '" text-anchor="middle" ' +
        'fill="var(--text-mute)" font-size="11">' + label + '</text>';
    }
  });

  const gradId = "trend-grad";
  svg.innerHTML = `
    <defs>
      <linearGradient id="${gradId}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${gridLines}
    <polygon points="${areaPoints}" fill="url(#${gradId})"/>
    <polyline points="${points}" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${trend.map((d, i) => {
      const x = padL + (n > 1 ? stepX * i : chartW / 2);
      const y = padT + chartH - (d.count / maxCount) * chartH;
      return `<circle cx="${x}" cy="${y}" r="3" fill="var(--primary)"/>`;
    }).join("")}
    ${xLabels}
  `;
}

function renderRankBars(data) {
  const container = document.getElementById("rank-bars");
  if (!data || !data.length) {
    container.innerHTML = '<div class="muted">暂无数据</div>';
    return;
  }
  const max = Math.max(...data.map((d) => d.call_count), 1);
  container.innerHTML = data.map((d, i) => {
    const pct = (d.call_count / max) * 100;
    const label = d.key_name || d.key_prefix;
    const idxCls = i === 0 ? "top1" : i === 1 ? "top2" : i === 2 ? "top3" : "";
    return `
      <div class="rank-item">
        <div class="rank-idx ${idxCls}">${i + 1}</div>
        <div class="rank-bar-wrap">
          <div class="rank-bar" style="width: ${pct}%"></div>
          <div class="rank-label">${esc(label)}</div>
        </div>
        <div class="rank-count">${d.call_count}</div>
      </div>
    `;
  }).join("");
}

/* ===== 上游管理 ===== */
function modelsHtml(models) {
  const list = (Array.isArray(models) ? models : []).filter((m) => String(m).trim());
  if (!list.length) return '<span class="muted">—</span>';
  return list.map((m) => '<span class="badge badge-model">' + esc(String(m).trim()) + "</span>").join(" ");
}
function renderUpstreams(ups) {
  const tb = document.getElementById("upstreams-tbody");
  if (!ups.length) {
    tb.innerHTML = '<tr><td colspan="8" class="muted">暂无上游配置</td></tr>';
    return;
  }
  tb.innerHTML = ups.map((u) => `
    <tr>
      <td>${u.id}</td>
      <td>${esc(u.name)}</td>
      <td>${esc(u.base_url)}</td>
      <td>${(u.protocol || "openai") === "anthropic" ? '<span class="badge badge-anthropic">Anthropic</span>' : '<span class="badge">OpenAI</span>'}</td>
      <td class="models-cell">${modelsHtml(u.models)}</td>
      <td>${u.is_default ? '<span class="badge badge-active">默认</span>' : '<span class="muted">—</span>'}</td>
      <td>${fmtTime(u.created_at)}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-edit-upstream="${u.id}">编辑</button>
        <button class="btn btn-danger btn-sm" data-delete-upstream="${u.id}">删除</button>
      </td>
    </tr>
  `).join("");

  tb.querySelectorAll("[data-edit-upstream]").forEach((btn) => {
    btn.addEventListener("click", () => openEditUpstream(parseInt(btn.dataset.editUpstream, 10)));
  });
  tb.querySelectorAll("[data-delete-upstream]").forEach((btn) => {
    btn.addEventListener("click", () => deleteUpstream(parseInt(btn.dataset.deleteUpstream, 10)));
  });
}

document.getElementById("create-upstream-btn").addEventListener("click", () => {
  document.getElementById("upstream-modal-title").textContent = "添加上游";
  document.getElementById("upstream-edit-id").value = "";
  document.getElementById("upstream-name").value = "";
  document.getElementById("upstream-base-url").value = "";
  document.getElementById("upstream-models").value = "";
  document.getElementById("upstream-api-key").value = "";
  document.getElementById("upstream-protocol").value = "openai";
  document.getElementById("upstream-is-default").checked = false;
  openModal("modal-upstream");
});

function openEditUpstream(id) {
  const up = _upstreamsCache.find((u) => u.id === id);
  if (!up) return;
  document.getElementById("upstream-modal-title").textContent = "编辑上游";
  document.getElementById("upstream-edit-id").value = up.id;
  document.getElementById("upstream-name").value = up.name;
  document.getElementById("upstream-base-url").value = up.base_url;
  document.getElementById("upstream-models").value = (up.models || []).join("\n");
  document.getElementById("upstream-api-key").value = up.api_key || "";
  document.getElementById("upstream-protocol").value = up.protocol || "openai";
  document.getElementById("upstream-is-default").checked = !!up.is_default;
  openModal("modal-upstream");
}

document.getElementById("upstream-submit").addEventListener("click", async () => {
  const id = document.getElementById("upstream-edit-id").value;
  const name = document.getElementById("upstream-name").value.trim();
  const baseUrl = document.getElementById("upstream-base-url").value.trim();
  const apiKey = document.getElementById("upstream-api-key").value;
  const protocol = document.getElementById("upstream-protocol").value || "openai";
  const isDefault = document.getElementById("upstream-is-default").checked;
  const models = document.getElementById("upstream-models").value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!name) { toast("请输入上游名称", "error"); return; }
  if (!baseUrl) { toast("请输入上游地址", "error"); return; }

  try {
    let res;
    const body = { name, base_url: baseUrl, api_key: apiKey, protocol, is_default: isDefault, models };
    if (id) {
      res = await api("/admin/upstreams/" + id, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    } else {
      res = await api("/admin/upstreams", {
        method: "POST",
        body: JSON.stringify(body),
      });
    }
    if (res.ok) {
      toast(id ? "已更新" : "已添加", "success");
      closeModal("modal-upstream");
      await loadUpstreams();
    } else {
      const errData = await res.json().catch(() => ({}));
      toast(errData.detail || "操作失败 (" + res.status + ")", "error");
    }
  } catch (e) { toast("操作失败：" + e.message, "error"); }
});

async function deleteUpstream(id) {
  if (!confirm("确定删除该上游？删除后绑定该上游的密钥将使用默认上游。")) return;
  try {
    const res = await api("/admin/upstreams/" + id, { method: "DELETE" });
    if (res.ok) { toast("已删除", "success"); loadUpstreams(); }
    else {
      const errData = await res.json().catch(() => ({}));
      toast(errData.detail || "删除失败 (" + res.status + ")", "error");
    }
  } catch (e) { toast("删除失败：" + e.message, "error"); }
}

/* ===== 用户管理 ===== */
let _usersCache = [];

async function loadUsers() {
  try {
    const res = await api("/admin/users");
    if (!res.ok) {
      if (res.status === 403) { toast("权限不足", "error"); return; }
      throw new Error("加载失败");
    }
    const users = await res.json();
    _usersCache = users;
    renderUsers(users);
  } catch (e) {
    document.getElementById("users-tbody").innerHTML =
      '<tr><td colspan="6" class="muted">加载失败</td></tr>';
  }
}

function renderUsers(users) {
  const tb = document.getElementById("users-tbody");
  if (!users.length) {
    tb.innerHTML = '<tr><td colspan="6" class="muted">暂无用户</td></tr>';
    return;
  }
  const currentId = getCurrentUser()?.id;
  tb.innerHTML = users.map((u) => `
    <tr>
      <td>${u.id}</td>
      <td>${esc(u.username)}</td>
      <td>${roleBadge(u.role)}</td>
      <td>${fmtTime(u.created_at)}</td>
      <td>${fmtTime(u.last_login_at)}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-edit-user="${u.id}">编辑</button>
        <button class="btn btn-danger btn-sm" data-delete-user="${u.id}"
          ${u.id === currentId ? 'disabled style="opacity:.5;cursor:not-allowed;"' : ''}>删除</button>
      </td>
    </tr>
  `).join("");

  tb.querySelectorAll("[data-edit-user]").forEach((btn) => {
    btn.addEventListener("click", () => openEditUser(parseInt(btn.dataset.editUser, 10)));
  });
  tb.querySelectorAll("[data-delete-user]").forEach((btn) => {
    btn.addEventListener("click", () => deleteUser(parseInt(btn.dataset.deleteUser, 10)));
  });
}

document.getElementById("create-user-btn").addEventListener("click", () => {
  document.getElementById("user-modal-title").textContent = "新建用户";
  document.getElementById("user-edit-id").value = "";
  document.getElementById("user-username").value = "";
  document.getElementById("user-username").disabled = false;
  document.getElementById("user-password").value = "";
  document.getElementById("user-password").placeholder = "请输入密码";
  document.getElementById("user-password-hint").style.display = "none";
  document.getElementById("user-role").value = "viewer";
  openModal("modal-user");
});

function openEditUser(id) {
  const user = _usersCache.find((u) => u.id === id);
  if (!user) return;
  document.getElementById("user-modal-title").textContent = "编辑用户";
  document.getElementById("user-edit-id").value = user.id;
  document.getElementById("user-username").value = user.username;
  document.getElementById("user-username").disabled = true;
  document.getElementById("user-password").value = "";
  document.getElementById("user-password").placeholder = "留空则不修改";
  document.getElementById("user-password-hint").style.display = "";
  document.getElementById("user-role").value = user.role;
  openModal("modal-user");
}

document.getElementById("user-submit").addEventListener("click", async () => {
  const id = document.getElementById("user-edit-id").value;
  const username = document.getElementById("user-username").value.trim();
  const password = document.getElementById("user-password").value;
  const role = document.getElementById("user-role").value;

  if (!id && !username) { toast("请输入用户名", "error"); return; }
  if (!id && !password) { toast("请输入密码", "error"); return; }

  try {
    let res;
    if (id) {
      const body = { role };
      if (password) body.password = password;
      res = await api("/admin/users/" + id, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    } else {
      res = await api("/admin/users", {
        method: "POST",
        body: JSON.stringify({ username, password, role }),
      });
    }
    if (res.ok) {
      toast(id ? "已更新" : "已创建", "success");
      closeModal("modal-user");
      loadUsers();
      await loadOverview();
    } else {
      const errData = await res.json().catch(() => ({}));
      toast(errData.detail || "操作失败 (" + res.status + ")", "error");
    }
  } catch (e) { toast("操作失败：" + e.message, "error"); }
});

async function deleteUser(id) {
  if (!confirm("确定删除该用户？删除后无法恢复。")) return;
  try {
    const res = await api("/admin/users/" + id, { method: "DELETE" });
    if (res.ok) { toast("已删除", "success"); loadUsers(); loadOverview(); }
    else {
      const errData = await res.json().catch(() => ({}));
      toast(errData.detail || "删除失败 (" + res.status + ")", "error");
    }
  } catch (e) { toast("删除失败：" + e.message, "error"); }
}

/* ===== Markdown 渲染 ===== */
function renderMarkdown(md, opts) {
  md = String(md == null ? "" : md);
  if (!md.trim()) return "";
  if (!(window.marked && window.marked.parse) || !window.DOMPurify) {
    // 缺少渲染库/净化库时安全降级为纯文本（不注入原始 HTML）
    return '<pre class="md-plain">' + esc(md) + "</pre>";
  }
  let html;
  try {
    html = window.marked.parse(md, { gfm: true, breaks: true });
  } catch (e) {
    return '<pre class="md-plain">' + esc(md) + "</pre>";
  }
  html = window.DOMPurify.sanitize(html);

  // light 模式：流式输出过程中使用，跳过 hljs 高亮与代码块包装，
  // 只做 parse+sanitize，渲染成本最低；流结束后再走完整渲染。
  if (opts && opts.light) return html;

  // 包装代码块：高亮 + 语言标签 + 复制按钮
  const holder = document.createElement("div");
  holder.innerHTML = html;
  holder.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code) return;
    const langMatch = (code.className.match(/language-([\w-]+)/) || [])[1] || "";
    const codeText = code.textContent;

    if (window.hljs && codeText.trim()) {
      try {
        let highlighted;
        if (langMatch && window.hljs.getLanguage(langMatch)) {
          highlighted = window.hljs.highlight(codeText, { language: langMatch }).value;
        } else {
          const res = window.hljs.highlightAuto(codeText);
          highlighted = res.value;
        }
        code.innerHTML = highlighted;
        code.classList.add("hljs");
        if (langMatch) code.classList.add("language-" + langMatch);
      } catch (e) { /* 高亮失败则保留原文 */ }
    }

    const langLabel = langMatch || "text";
    const wrap = document.createElement("div");
    wrap.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    const span = document.createElement("span");
    span.className = "code-lang";
    span.textContent = langLabel;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-code-btn";
    btn.textContent = "复制";
    head.appendChild(span);
    head.appendChild(btn);
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(head);
    wrap.appendChild(pre);
  });
  return holder.innerHTML;
}

// 统一处理“复制代码块”按钮与气泡外快捷工具条（事件委托，兼容流式重渲染）
function handleChatClick(e) {
  const copyBtn = e.target.closest(".copy-code-btn");
  if (copyBtn) {
    const block = copyBtn.closest(".code-block");
    const codeEl = block && block.querySelector("pre code");
    const text = codeEl ? codeEl.textContent : "";
    copyToClipboard(text, copyBtn);
    return;
  }
  const actBtn = e.target.closest(".chat-act-btn");
  if (!actBtn) return;
  // 工具条 (.chat-msg-actions) 与气泡 (.chat-bubble) 是兄弟节点，
  // 通过预先挂的引用找到所属气泡，避免冒泡层数不对导致的 closest 失效
  const actionsEl = actBtn.closest(".chat-msg-actions");
  const bubble = (actionsEl && actionsEl._bubble) || actBtn.closest(".chat-bubble");
  if (!bubble) return;
  const act = actBtn.dataset.act;
  if (act === "copy") {
    copyToClipboard(bubble._rawText || "", actBtn);
  } else if (act === "like") {
    const dislike = bubble._actionsEl && bubble._actionsEl.querySelector('[data-act="dislike"]');
    if (actBtn.classList.contains("liked")) {
      actBtn.classList.remove("liked");
    } else {
      actBtn.classList.add("liked");
      if (dislike) dislike.classList.remove("disliked");
      toast("感谢反馈", "success");
    }
  } else if (act === "dislike") {
    const like = bubble._actionsEl && bubble._actionsEl.querySelector('[data-act="like"]');
    if (actBtn.classList.contains("disliked")) {
      actBtn.classList.remove("disliked");
    } else {
      actBtn.classList.add("disliked");
      if (like) like.classList.remove("liked");
      toast("已记录", "success");
    }
  } else if (act === "speak") {
    toggleSpeak(bubble, actBtn);
  } else if (act === "regen") {
    regenAssistant(bubble);
  } else if (act === "share") {
    shareAssistant(bubble, actBtn);
  }
}

async function copyToClipboard(text, btn) {
  const labelEl = btn.querySelector(".act-label") || btn;
  const label = labelEl.textContent;
  let ok = false;
  // 优先用 Clipboard API；用户手势缺失/权限拒绝时会 reject，降级到 textarea + execCommand
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (_) { /* 忽略，写入失败走兜底 */ }
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch (_) {}
  }
  if (!ok) {
    toast("复制失败：请手动选择文本复制", "error");
    return;
  }
  labelEl.textContent = "已复制";
  btn.classList.add("copied");
  setTimeout(() => {
    labelEl.textContent = label;
    btn.classList.remove("copied");
  }, 1500);
}

/* ===== 对话 ===== */
let _chatMessages = [];
let _chatLoading = false;

let _chatSelectedKey = "";
let _chatAutoModel = "";  // 记录最后一次自动填充的模型名，便于切换密钥时随上游刷新
let _chatKeysCache = [];

async function loadChatKeys() {
  const sel = document.getElementById("chat-key");
  if (!sel) return;
  const keys = await loadKeys();
  _chatKeysCache = keys;
  const activeKeys = keys.filter((k) => k.status === "active");
  sel.innerHTML = '<option value="">请选择密钥</option>';
  activeKeys.forEach((k) => {
    const opt = document.createElement("option");
    opt.value = k.id;
    opt.textContent = (k.name || k.key_prefix) + " (" + k.key_prefix + "…)";
    sel.appendChild(opt);
  });
  if (activeKeys.length > 0 && !sel.value) {
    sel.value = activeKeys[0].id;
    sel.dispatchEvent(new Event("change"));
  }
}

// 对话测试页 模型下拉交互绑定
(function initModelPicker() {
  const input = document.getElementById("chat-model");
  const caret = document.getElementById("chat-model-caret");
  const picker = document.getElementById("model-picker");
  if (!input || !caret || !picker) return;

  // 阻止 mousedown 默认行为，避免焦点从 input 移到 caret 触发 blur 关菜单
  caret.addEventListener("mousedown", (e) => { e.preventDefault(); });
  caret.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const willOpen = !_chatModelOpen;
    willOpen ? modelMenuOpen() : modelMenuClose();
    if (willOpen && document.activeElement !== input) input.focus({ preventScroll: true });
  });

  input.addEventListener("focus", () => {
    if (_chatModelOptions.length) modelMenuOpen();
  });
  input.addEventListener("input", () => {
    if (_chatModelOpen) modelMenuRender();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); modelMenuMove(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); modelMenuMove(-1); }
    else if (e.key === "Enter" && _chatModelOpen && _chatModelHl >= 0) { e.preventDefault(); pickChatModel(document.querySelector("#chat-model-menu .model-menu-item.hl").dataset.model); }
    else if (e.key === "Escape" && _chatModelOpen) { e.preventDefault(); modelMenuClose(); }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => { if (_chatModelOpen) modelMenuClose(); }, 160);
  });
  document.addEventListener("click", (e) => {
    if (_chatModelOpen && !picker.contains(e.target)) modelMenuClose();
  });
})();

document.getElementById("chat-key-mode").addEventListener("change", (e) => {
  const mode = e.target.value;
  document.getElementById("chat-key-select-wrap").hidden = mode !== "select";
  document.getElementById("chat-key-manual-wrap").hidden = mode !== "manual";
});

document.getElementById("chat-key").addEventListener("change", async (e) => {
  const keyId = parseInt(e.target.value, 10);
  _chatSelectedKey = "";
  const errEl = document.getElementById("chat-key-error");
  if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
  if (!keyId) return;
  try {
    const res = await api("/admin/keys/" + keyId + "/reveal");
    if (res.ok) {
      const data = await res.json();
      _chatSelectedKey = data.key || "";
    } else {
      const errData = await res.json().catch(() => ({}));
      let msg = errData.detail || ("加载失败 (" + res.status + ")");
      if (res.status === 410) {
        // 历史遗留密钥无明文：给出可操作的引导，避免死胡同
        msg = "该密钥无明文可回显（创建于明文回显功能上线之前或数据重建过）。";
        errEl.innerHTML = "";
        errEl.append("⚠ 密钥加载失败：" + msg);
        const go = document.createElement("button");
        go.type = "button";
        go.className = "btn btn-ghost btn-sm";
        go.textContent = "去密钥管理重置";
        go.style.marginLeft = "8px";
        go.addEventListener("click", () => switchView("keys"));
        errEl.appendChild(go);
        errEl.hidden = false;
        return;
      }
      if (errEl) { errEl.textContent = "⚠ 密钥加载失败：" + msg; errEl.hidden = false; }
    }
  } catch (e) {
    if (errEl) { errEl.textContent = "⚠ 网络错误：" + e.message; errEl.hidden = false; }
  }
  updateChatModelList();
  applyUpstreamModelsToChat(keyId);
});

// ===== 聊天气泡外快捷工具条图标（SVG，使用 currentColor，参考 ChatGPT / 豆包 风格） =====
const ICON_COPY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_THUMB_UP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11"/><path d="M7 10l4.5-7a2 2 0 0 1 2 2.2V10h5.4a2 2 0 0 1 2 2.3l-1.5 6.5A2 2 0 0 1 17.4 21H7"/></svg>';
const ICON_THUMB_DOWN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V3"/><path d="M17 14l-4.5 7a2 2 0 0 1-2-2.2V14H5.1a2 2 0 0 1-2-2.3L4.6 5.2A2 2 0 0 1 6.6 3H17"/></svg>';
const ICON_SPEAKER = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const ICON_REGEN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>';
const ICON_SHARE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v14"/></svg>';

function addChatMsg(role, content) {
  const box = document.getElementById("chat-messages");
  const wrap = document.createElement("div");
  wrap.className = "chat-msg chat-msg-" + role;

  const avatar = document.createElement("div");
  avatar.className = "chat-avatar";
  avatar.textContent = role === "user" ? "我" : "AI";

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";

  if (role === "assistant") {
    // 助手气泡：Markdown 内容区
    bubble.classList.add("chat-bubble-md");

    const body = document.createElement("div");
    body.className = "chat-bubble-content";

    bubble.appendChild(body);
    bubble._contentEl = body;
    bubble._rawText = content || "";

    // 统一的文本更新入口：raw=true 显示纯文本（调试/错误），否则渲染 Markdown
    // light=true 为流式中间态的轻量渲染（不做代码高亮/复制按钮包装）
    bubble.setMsg = (text, opts) => {
      const t = String(text == null ? "" : text);
      bubble._rawText = t;
      if (opts && opts.raw) {
        body.classList.add("raw");
        body.textContent = t;
      } else {
        body.classList.remove("raw");
        body.innerHTML = renderMarkdown(t, opts);
      }
    };

    if (content) bubble.setMsg(content);

    // "正在思考"等待态：规范化的 typing 指示器（三点跳动 + 文案），
    // 收到首个 token / 出错后会被 setMsg 的内容替换掉
    bubble.setTyping = (text) => {
      bubble._rawText = "";
      body.classList.remove("raw");
      body.innerHTML =
        '<div class="chat-typing" role="status" aria-live="polite">' +
        '<span class="typing-dot"></span>' +
        '<span class="typing-dot"></span>' +
        '<span class="typing-dot"></span>' +
        '<span class="typing-text">' + esc(text || "正在思考") + "</span>" +
        "</div>";
    };

    // 气泡外下方快捷操作栏（参考 ChatGPT / 豆包 风格）
    const actions = document.createElement("div");
    actions.className = "chat-msg-actions";
    const actDefs = [
      { act: "copy",    label: "复制", title: "复制 Markdown 原文",                svg: ICON_COPY },
      { act: "like",    label: "点赞", title: "这条回复有帮助",                    svg: ICON_THUMB_UP },
      { act: "dislike", label: "点踩", title: "这条回复有问题",                    svg: ICON_THUMB_DOWN },
      { act: "speak",   label: "朗读", title: "朗读 / 停止",                       svg: ICON_SPEAKER },
      { act: "regen",   label: "重新生成", title: "用相同问题再问一次",              svg: ICON_REGEN },
      { act: "share",   label: "分享", title: "复制带模型与时间的可分享内容",      svg: ICON_SHARE },
    ];
    for (const a of actDefs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-act-btn";
      btn.dataset.act = a.act;
      btn.title = a.title;
      btn.setAttribute("aria-label", a.title);
      btn.innerHTML = a.svg + '<span class="act-label">' + a.label + "</span>";
      actions.appendChild(btn);
    }
    bubble._actionsEl = actions;
    // 让工具条上的按钮通过 _bubble 反向找到所属气泡（避免最外层 closest 走错层）
    actions._bubble = bubble;
    // 记录该 assistant 对应的 user 消息在 _chatMessages 中的索引，供重新生成时切片
    bubble._userMsgIndex = _chatMessages.length - 1;

    // assistant 行的列容器：avatar | col(bubble + actions)
    const col = document.createElement("div");
    col.className = "chat-col";
    col.appendChild(bubble);
    col.appendChild(actions);
    wrap.appendChild(avatar);
    wrap.appendChild(col);
  } else {
    // user / system 消息：纯文本气泡
    bubble.textContent = content || "";
    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
  }

  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
  return bubble;
}

function clearChat() {
  _chatMessages = [];
  const box = document.getElementById("chat-messages");
  box.innerHTML = '<div class="chat-msg chat-msg-system"><div class="chat-bubble">对话已清空，开始新的对话吧～</div></div>';
}

document.getElementById("chat-clear-ctx").addEventListener("click", clearChat);

function getChatApiKey() {
  const mode = document.getElementById("chat-key-mode").value;
  if (mode === "manual") {
    return document.getElementById("chat-key-manual").value.trim();
  }
  return _chatSelectedKey || "";
}

async function _runChatRequest({ model, messages, temperature, stream, raw, apiKey, bubble }) {
  const payload = { model, messages, temperature, stream };
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
    bubble.setMsg("请求失败 (HTTP " + res.status + ")\n" + t, { raw: true });
    const err = new Error("HTTP " + res.status);
    err._httpError = true;
    throw err;
  }
  if (raw) {
    const ct = res.headers.get("content-type") || "";
    if (stream || ct.includes("text/event-stream")) {
      return await readRawStream(res, bubble);
    }
    const data = await res.json();
    const s = JSON.stringify(data, null, 2);
    bubble.setMsg(s, { raw: true });
    return s;
  }
  if (stream) {
    return await readChatStream(res, bubble);
  }
  const data = await res.json();
  const content =
    (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  bubble.setMsg(content, { raw: false });
  return content;
}

async function sendChat() {
  if (_chatLoading) return;
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;

  const model = document.getElementById("chat-model").value.trim();
  const temp = parseFloat(document.getElementById("chat-temp").value) || 0.7;
  const stream = document.getElementById("chat-stream").checked;
  const raw = document.getElementById("chat-raw").checked;
  const apiKey = getChatApiKey();

  if (!apiKey) {
    const mode = document.getElementById("chat-key-mode").value;
    toast(mode === "manual" ? "请输入 API Key" : "请选择密钥或切换为手动输入", "error");
    return;
  }
  if (!model) { toast("请输入模型名称", "error"); return; }

  _chatLoading = true;
  document.getElementById("chat-send").disabled = true;
  input.value = "";

  const userMsg = { role: "user", content: text };
  const messages = raw ? [userMsg] : [..._chatMessages, userMsg];
  if (!raw) _chatMessages.push(userMsg);
  addChatMsg("user", text);
  const bubble = addChatMsg("assistant", "");
  if (raw) bubble.setMsg("请求中...", { raw: true });
  else bubble.setTyping("AI 正在思考");

  try {
    const full = await _runChatRequest({
      model, messages, temperature: temp, stream, raw, apiKey, bubble,
    });
    if (!raw) _chatMessages.push({ role: "assistant", content: full });
    refreshAll();
  } catch (e) {
    if (!raw && e && e._httpError) _chatMessages.pop(); // 请求失败：弹出刚 push 的 user
  } finally {
    _chatLoading = false;
    document.getElementById("chat-send").disabled = false;
  }
}

async function regenAssistant(bubble) {
  if (_chatLoading) return;
  if (!bubble || bubble._userMsgIndex == null || bubble._userMsgIndex < 0) {
    toast("当前回复无法重新生成", "error");
    return;
  }
  const regenBtn = bubble._actionsEl && bubble._actionsEl.querySelector('[data-act="regen"]');
  if (regenBtn) regenBtn.classList.add("loading");

  const model = document.getElementById("chat-model").value.trim();
  const temp = parseFloat(document.getElementById("chat-temp").value) || 0.7;
  const stream = document.getElementById("chat-stream").checked;
  const apiKey = getChatApiKey();
  if (!apiKey) { toast("请先配置 API Key", "error"); if (regenBtn) regenBtn.classList.remove("loading"); return; }
  if (!model) { toast("请输入模型名称", "error"); if (regenBtn) regenBtn.classList.remove("loading"); return; }

  _chatLoading = true;
  document.getElementById("chat-send").disabled = true;

  // 取该 assistant 之前（含对应 user 消息）的对话历史
  const messages = _chatMessages.slice(0, bubble._userMsgIndex + 1);
  // 先把原回答暂存，若重新生成失败时回填
  const oldRaw = bubble._rawText;
  const oldDom = bubble._contentEl.innerHTML;
  bubble.setTyping("正在重新生成");

  try {
    const full = await _runChatRequest({
      model, messages, temperature: temp, stream, raw: false, apiKey, bubble,
    });
    _chatMessages[bubble._userMsgIndex + 1] = { role: "assistant", content: full };
    refreshAll();
  } catch (e) {
    bubble._rawText = oldRaw;
    bubble._contentEl.innerHTML = oldDom;
    toast("重新生成失败：" + (e && e.message || ""), "error");
  } finally {
    _chatLoading = false;
    if (regenBtn) regenBtn.classList.remove("loading");
    document.getElementById("chat-send").disabled = false;
  }
}

let _chatSpeakingBubble = null;
function toggleSpeak(bubble, btn) {
  if (!window.speechSynthesis) {
    toast("当前浏览器不支持语音朗读", "error");
    return;
  }
  // 同一时刻只允许朗读一条；再点同一气泡或换气泡都会切换
  if (_chatSpeakingBubble === bubble) {
    window.speechSynthesis.cancel();
    _chatSpeakingBubble = null;
    if (btn) btn.classList.remove("speaking");
    return;
  }
  if (_chatSpeakingBubble) {
    window.speechSynthesis.cancel();
    const prevBtn = _chatSpeakingBubble._actionsEl
      && _chatSpeakingBubble._actionsEl.querySelector('[data-act="speak"]');
    if (prevBtn) prevBtn.classList.remove("speaking");
  }
  const text = bubble._rawText || "";
  if (!text.trim()) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "zh-CN";
  u.rate = 1.0;
  u.onend = u.onerror = () => {
    if (_chatSpeakingBubble === bubble) _chatSpeakingBubble = null;
    if (btn) btn.classList.remove("speaking");
  };
  _chatSpeakingBubble = bubble;
  if (btn) btn.classList.add("speaking");
  window.speechSynthesis.speak(u);
}

async function shareAssistant(bubble, btn) {
  const text = bubble._rawText || "";
  if (!text) return;
  const model = (document.getElementById("chat-model").value || "").trim() || "(model)";
  const ts = new Date().toLocaleString("zh-CN", { hour12: false });
  const payload = "【模型】" + model + "\n【时间】" + ts + "\n\n" + text;
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(payload);
      ok = true;
    }
  } catch (_) {}
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = payload;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch (_) {}
  }
  if (!ok) { toast("分享失败：" + (window.navigator.clipboard ? "浏览器拒绝写入" : "浏览器不支持"), "error"); return; }
  toast("已复制分享内容（含模型与时间）", "success");
  const labelEl = btn.querySelector(".act-label");
  if (labelEl) {
    const old = labelEl.textContent;
    labelEl.textContent = "已复制";
    setTimeout(() => { labelEl.textContent = old; }, 1500);
  }
  btn.classList.add("copied");
  setTimeout(() => btn.classList.remove("copied"), 1500);
}

async function readRawStream(res, bubble) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let done = false;
  let all = "";
  while (!done) {
    const { value, done: d } = await reader.read();
    done = d;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) all += line + "\n";
    }
    if (bubble && bubble.setMsg) bubble.setMsg(all, { raw: true });
    const box = document.getElementById("chat-messages");
    box.scrollTop = box.scrollHeight;
  }
  return all;
}

async function readChatStream(res, bubble) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let done = false;
  let full = "";
  let started = false; // 是否已收到首个内容 token
  let renderTimer = null;
  let lastRender = 0;
  const box = document.getElementById("chat-messages");
  const scroll = () => {
    if (box) box.scrollTop = box.scrollHeight;
  };

  // light=true：流式中间态，跳过 hljs 高亮等昂贵步骤；light=false：完整渲染
  const renderNow = (light) => {
    renderTimer = null;
    lastRender = Date.now();
    if (!bubble || !bubble.setMsg) return;
    bubble.setMsg(full, light ? { light: true } : {});
    scroll();
  };

  // 自适应渲染间隔：内容越长、单次全量解析越贵，间隔随之拉大，
  // 避免每个增量块都触发一次 O(n) 重排把主线程占死（表现为“半天没输出”）
  const gapFor = (len) =>
    len < 1000 ? 60 : len < 4000 ? 120 : len < 10000 ? 200 : 320;

  const scheduleRender = (light) => {
    if (!full || renderTimer) return;
    const gap = gapFor(full.length);
    const wait = Math.max(0, gap - (Date.now() - lastRender));
    renderTimer = setTimeout(() => renderNow(light), wait);
  };

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
      if (data === "[DONE]") {
        done = true;
        break;
      }
      try {
        const json = JSON.parse(data);
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (delta && delta.content) {
          full += delta.content;
          if (started) {
            scheduleRender(true);
          } else {
            // 首个 token：立刻渲染，替换“正在思考…”占位
            started = true;
            lastRender = 0;
            renderNow(true);
          }
        }
      } catch { /* 忽略非 JSON 心跳行 */ }
    }
  }
  // 流结束：清掉待执行的定时器，做一次完整渲染（代码高亮 + 复制按钮）
  if (renderTimer) clearTimeout(renderTimer);
  renderNow(false);
  return full;
}

const chatMessagesBox = document.getElementById("chat-messages");
chatMessagesBox.addEventListener("click", handleChatClick);
document.getElementById("chat-send").addEventListener("click", sendChat);
document.getElementById("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

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
if (getToken() && getCurrentUser()) { showApp(); } else { showLogin(); }
