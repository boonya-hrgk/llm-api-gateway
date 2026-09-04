/* 应用入口：会话检查、壳级事件（登录/登出/清缓存/主题/导航）、启动路由。 */
import {
  getToken, getCurrentUser, setToken, setCurrentUser, logout, showLogin,
} from "./api.js";
import { applyRoleVisibility, defaultView, navigate, reset } from "./router.js";
import { toast } from "./util.js";

function refreshUserInfo() {
  const user = getCurrentUser();
  if (!user) return;
  document.getElementById("user-name").textContent = user.username;
  document.getElementById("user-role").textContent = user.role === "admin" ? "管理员" : "普通用户";
  document.getElementById("user-avatar").textContent = user.username.charAt(0).toUpperCase();
}

function showApp() {
  document.getElementById("login-view").hidden = true;
  document.getElementById("app-view").hidden = false;
  applyRoleVisibility();
  refreshUserInfo();
  navigate(defaultView());
}

/* ---------- 登录 ---------- */
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

/* ---------- 登出：清理会话并释放已挂载视图 ---------- */
document.getElementById("logout-btn").addEventListener("click", logout);
document.addEventListener("gateway:logout", () => {
  reset();
  showLogin();
});

/* ---------- 清除浏览器缓存并刷新 ---------- */
document.getElementById("clear-cache-btn").addEventListener("click", async function () {
  const btn = this;
  btn.disabled = true;
  btn.textContent = "清理中…";
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e2) { /* CacheStorage 不可用则跳过 */ }
  // api() 已默认 no-store，HTTP 缓存不会被读取；reload 会重新校验文档与带版本号的静态资源
  try { sessionStorage.setItem("cache_cleared_toast", "1"); } catch (e3) { /* 忽略 */ }
  location.reload();
});
if (sessionStorage.getItem("cache_cleared_toast") === "1") {
  try { sessionStorage.removeItem("cache_cleared_toast"); } catch (e4) { /* 忽略 */ }
  toast("浏览器缓存已清理", "success");
}

/* ---------- 主题切换 ---------- */
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

/* ---------- 左侧菜单（重复点击当前菜单 = 手动刷新该页） ---------- */
document.querySelectorAll(".nav-item[data-view]").forEach((el) => {
  el.addEventListener("click", (e) => { e.preventDefault(); navigate(el.dataset.view); });
});

/* ---------- 启动 ---------- */
if (getToken() && getCurrentUser()) { showApp(); } else { showLogin(); }
