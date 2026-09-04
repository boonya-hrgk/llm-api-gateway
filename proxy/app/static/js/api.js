/* 会话（sessionStorage）与 fetch 封装；登录/登出只做会话与视图切换。 */

const TOKEN_KEY = "ai_gateway_token";
const USER_KEY = "ai_gateway_user";

export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (v) => sessionStorage.setItem(TOKEN_KEY, v);
export const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

export function getCurrentUser() {
  try { return JSON.parse(sessionStorage.getItem(USER_KEY) || "null"); }
  catch { return null; }
}
export const setCurrentUser = (u) => sessionStorage.setItem(USER_KEY, JSON.stringify(u));
export const clearCurrentUser = () => sessionStorage.removeItem(USER_KEY);
export const isAdmin = () => getCurrentUser()?.role === "admin";

export function showLogin() {
  const login = document.getElementById("login-view");
  const app = document.getElementById("app-view");
  if (login) login.hidden = false;
  if (app) app.hidden = true;
}

export function logout() {
  clearToken();
  clearCurrentUser();
  showLogin();
  document.dispatchEvent(new CustomEvent("gateway:logout"));
}

export async function api(path, opts = {}) {
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
