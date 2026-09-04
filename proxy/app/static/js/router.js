/* 视图路由：按需加载 views/*.html 片段 → 挂到 #view-root → 首次绑定 → 每次进入刷新数据。 */
import { getCurrentUser, isAdmin } from "./api.js";
import { toast } from "./util.js";

// 每个菜单允许的角色；普通用户只能看到 用量统计 / 对话测试
export const ROLE_VIEWS = {
  overview: ["admin"],
  stats: ["admin", "viewer"],
  keys: ["admin"],
  upstreams: ["admin"],
  users: ["admin"],
  chat: ["admin", "viewer"],
};

const TITLES = {
  overview: "系统概览",
  stats: "用量统计",
  keys: "密钥管理",
  upstreams: "上游管理",
  users: "用户管理",
  chat: "对话测试",
};

export function viewAllowed(view) {
  const roles = ROLE_VIEWS[view];
  if (!roles) return true;
  return roles.indexOf(getCurrentUser()?.role) >= 0;
}

export function defaultView() {
  return isAdmin() ? "overview" : "stats";
}

export function applyRoleVisibility() {
  const admin = isAdmin();
  // 按钮 / 列等细粒度元素（管理员才渲染的页面本身只有管理员可进入，主要为登录态切换兜底）
  document.querySelectorAll(".admin-only").forEach((el) => {
    el.style.display = admin ? "" : "none";
  });
  // 左侧菜单按角色显隐
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => {
    el.style.display = viewAllowed(el.dataset.view) ? "" : "none";
  });
}

const _mounting = new Map(); // name -> Promise<container>
const _containers = new Map(); // name -> Element

async function _loadPage(name) {
  // 已挂载并常驻的节点直接复用：同一视图只创建一次，避免重复 id 导致数据渲染到隐藏节点
  const cached = _containers.get(name);
  if (cached) return cached;
  if (_mounting.has(name)) return _mounting.get(name);
  const p = (async () => {
    const host = document.getElementById("view-root");
    const res = await fetch("/views/" + name + ".html");
    if (!res.ok) throw new Error("视图加载失败 (" + name + ", HTTP " + res.status + ")");
    const html = await res.text();

    const container = document.createElement("div");
    container.dataset.viewGroup = name;
    container.hidden = true;
    container.innerHTML = html;
    host.appendChild(container);

    const section = container.querySelector("#view-" + name);
    if (!section) throw new Error("视图片段缺少 section#" + name);

    const page = await import("/js/pages/" + name + ".js");
    if (page.bindView) page.bindView(container);
    return container;
  })();
  _mounting.set(name, p);
  try {
    const container = await p;
    _containers.set(name, container);
    return container;
  } finally {
    _mounting.delete(name);
  }
}

let _current = null;

/* 判断某视图是否仍处于“未加载”状态（加载中占位 / 空卡片）。
 * 用于切回时自愈：已正常加载 → 保持原样；仍是占位 → 补一次数据加载。 */
function _viewLooksUnloaded(container) {
  if (!container) return false;
  if ((container.textContent || "").indexOf("加载中") >= 0) return true;
  const statNums = container.querySelectorAll(".stat-num");
  for (const s of statNums) {
    if ((s.textContent || "").trim() === "-") return true;
  }
  return false;
}

/* 视图切换（带缓存）：
 * - 首次打开：挂载 fragment → bindView → enter() 加载数据，此后节点常驻缓存；
 * - 之后再切回来：仅显示已缓存 DOM，保持原样（滚动/输入/聊天等均不重置），不重新拉数据；
 * - 需要强制刷新时传 { refresh: true }（重复点击当前菜单 = 手动刷新该页）。 */
export async function switchView(name, opts = {}) {
  const refresh = !!opts.refresh;
  if (!viewAllowed(name)) {
    toast("权限不足", "error");
    name = defaultView();
  }

  // 导航高亮与标题
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === name);
  });
  const titleEl = document.getElementById("page-title");
  if (titleEl) titleEl.textContent = TITLES[name] || "";

  let container;
  try {
    container = await _loadPage(name);
  } catch (e) {
    toast(e.message || "视图加载失败", "error");
    return;
  }

  document.querySelectorAll("#view-root [data-view-group]").forEach((c) => {
    c.hidden = true;
  });
  container.hidden = false;
  const section = container.querySelector("#view-" + name);
  if (section) section.hidden = false;
  _current = name;

  // 已正常加载且非手动刷新、也不处于“未加载”状态 → 直接展示缓存，不再渲染
  if (container._entered && !refresh && !_viewLooksUnloaded(container)) return;
  try {
    const page = await import("/js/pages/" + name + ".js");
    if (page.enter) await page.enter();
    container._entered = true;
  } catch (e) {
    console.error("视图加载失败:", name, e);
  }
}

/* 菜单点击入口：已打开的页面保持原样（除非刷新浏览器）；再次点击当前菜单不做任何改动 */
export async function navigate(name) {
  if (name === _current) return;
  await switchView(name);
}

/* 清空已挂载的视图片段（登出时调用），避免跨会话残留 DOM/聊天记录。 */
export function reset() {
  const host = document.getElementById("view-root");
  if (host) host.innerHTML = "";
  _containers.clear();
  _current = null;
}
