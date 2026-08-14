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
    if (!document.getElementById("chat-model").value) {
      document.getElementById("chat-model").value = "deepseek-coder-33b-instruct-AWQ";
    }
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
    return data;
  } catch (e) { return []; }
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
      html += '<td>' + (k.status === "active"
        ? '<button class="btn btn-danger btn-sm" data-revoke="' + k.id + '">吊销</button>'
        : '<span class="muted">—</span>') + "</td>";
    }
    html += "</tr>";
    return html;
  }).join("");

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

/* ===== 新建/吊销密钥 ===== */
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
    const d = new Date(expires);
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
    const keyText = data.key || "";
    const keyEl = document.getElementById("new-key-text");
    keyEl.textContent = keyText;
    if (!keyText) {
      keyEl.textContent = "⚠ 密钥为空，请刷新页面后重试";
      keyEl.style.color = "var(--danger)";
    }
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
    else if (res.status === 403) { toast("权限不足", "error"); }
    else { toast("吊销失败 (" + res.status + ")", "error"); }
  } catch (e) { toast("吊销失败：" + e.message, "error"); }
}

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
function renderUpstreams(ups) {
  const tb = document.getElementById("upstreams-tbody");
  if (!ups.length) {
    tb.innerHTML = '<tr><td colspan="6" class="muted">暂无上游配置</td></tr>';
    return;
  }
  tb.innerHTML = ups.map((u) => `
    <tr>
      <td>${u.id}</td>
      <td>${esc(u.name)}</td>
      <td>${esc(u.base_url)}</td>
      <td>${u.api_key ? esc(u.api_key.slice(0, 8) + "…") : '<span class="muted">—</span>'}</td>
      <td>${u.is_default ? '<span class="badge badge-active">默认</span>' : '<span class="muted">—</span>'}</td>
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
  document.getElementById("upstream-api-key").value = "";
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
  document.getElementById("upstream-api-key").value = up.api_key || "";
  document.getElementById("upstream-is-default").checked = !!up.is_default;
  openModal("modal-upstream");
}

document.getElementById("upstream-submit").addEventListener("click", async () => {
  const id = document.getElementById("upstream-edit-id").value;
  const name = document.getElementById("upstream-name").value.trim();
  const baseUrl = document.getElementById("upstream-base-url").value.trim();
  const apiKey = document.getElementById("upstream-api-key").value;
  const isDefault = document.getElementById("upstream-is-default").checked;

  if (!name) { toast("请输入上游名称", "error"); return; }
  if (!baseUrl) { toast("请输入上游地址", "error"); return; }

  try {
    let res;
    const body = { name, base_url: baseUrl, api_key: apiKey, is_default: isDefault };
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

/* ===== 对话 ===== */
let _chatMessages = [];
let _chatLoading = false;

let _chatSelectedKey = "";

async function loadChatKeys() {
  const sel = document.getElementById("chat-key");
  if (!sel) return;
  const keys = await loadKeys();
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
      const msg = errData.detail || ("加载失败 (" + res.status + ")");
      if (errEl) { errEl.textContent = "⚠ 密钥加载失败：" + msg; errEl.hidden = false; }
    }
  } catch (e) {
    if (errEl) { errEl.textContent = "⚠ 网络错误：" + e.message; errEl.hidden = false; }
  }
});

function addChatMsg(role, content) {
  const box = document.getElementById("chat-messages");
  const wrap = document.createElement("div");
  wrap.className = "chat-msg chat-msg-" + role;

  const avatar = document.createElement("div");
  avatar.className = "chat-avatar";
  avatar.textContent = role === "user" ? "我" : "AI";

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = content;

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
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
  if (!raw) {
    _chatMessages.push(userMsg);
  }
  addChatMsg("user", text);

  const assistantBubble = addChatMsg("assistant", "");
  if (raw) {
    assistantBubble.textContent = "请求中...";
  }

  const payload = {
    model,
    messages,
    temperature: temp,
    stream,
  };

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
      assistantBubble.textContent = "请求失败 (HTTP " + res.status + ")\n" + t;
      if (!raw) _chatMessages.pop();
      _chatLoading = false;
      document.getElementById("chat-send").disabled = false;
      return;
    }

    if (raw) {
      const ct = res.headers.get("content-type") || "";
      if (stream || ct.includes("text/event-stream")) {
        const fullRaw = await readRawStream(res);
        assistantBubble.textContent = fullRaw;
        assistantBubble.style.fontFamily = "monospace";
        assistantBubble.style.fontSize = "12px";
      } else {
        const data = await res.json();
        assistantBubble.textContent = JSON.stringify(data, null, 2);
        assistantBubble.style.fontFamily = "monospace";
        assistantBubble.style.fontSize = "12px";
      }
    } else if (stream) {
      const full = await readChatStream(res, assistantBubble);
      _chatMessages.push({ role: "assistant", content: full });
    } else {
      const data = await res.json();
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "";
      assistantBubble.textContent = content;
      _chatMessages.push({ role: "assistant", content });
    }
    refreshAll();
  } catch (e) {
    assistantBubble.textContent = "请求失败：" + e.message;
    if (!raw) _chatMessages.pop();
  }

  _chatLoading = false;
  document.getElementById("chat-send").disabled = false;
}

async function readRawStream(res) {
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
    const box = document.getElementById("chat-messages");
    if (box.lastElementChild) {
      const bubble = box.lastElementChild.querySelector(".chat-bubble");
      if (bubble) bubble.textContent = all;
    }
    box.scrollTop = box.scrollHeight;
  }
  return all;
}

async function readChatStream(res, bubbleEl) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let done = false;
  let full = "";
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
      if (data === "[DONE]") return full;
      try {
        const json = JSON.parse(data);
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (delta && delta.content) {
          full += delta.content;
          bubbleEl.textContent = full;
          const box = document.getElementById("chat-messages");
          box.scrollTop = box.scrollHeight;
        }
      } catch { /* 忽略非 JSON 心跳行 */ }
    }
  }
  return full;
}

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
