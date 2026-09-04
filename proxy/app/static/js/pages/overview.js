/* 系统概览：卡片汇总 + 最近密钥 */
import { api, isAdmin } from "../api.js";
import { esc, fmtNum, fmtTime, keyStateBadge } from "../util.js";
import { loadKeys } from "../data.js";

async function loadOverview() {
  try {
    const res = await api("/admin/stats/overview");
    if (!res.ok) throw new Error("加载失败");
    const data = await res.json();
    document.getElementById("stat-total").textContent = data.total_keys;
    document.getElementById("stat-active").textContent = data.active_keys;
    document.getElementById("stat-users").textContent = data.total_users;
    document.getElementById("stat-today").textContent = data.today_calls;
    document.getElementById("stat-today-tokens").textContent = fmtNum(data.today_tokens);
    document.getElementById("stat-cache-today").textContent = fmtNum(data.today_cache_read_tokens || 0);
    document.getElementById("stat-calls").textContent = data.total_calls;
    document.getElementById("stat-total-tokens").textContent = fmtNum(data.total_tokens);
    document.getElementById("stat-cache-total").textContent = fmtNum(data.total_cache_read_tokens || 0);
  } catch (e) {
    console.error(e);
  }
}

function renderOverview(keys) {
  const tb = document.getElementById("overview-tbody");
  if (!keys.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">暂无密钥</td></tr>'; return; }
  tb.innerHTML = keys.slice(0, 5).map((k) =>
    "<tr><td>" + esc(k.key_prefix) + "</td><td>" + esc(k.name || "—") +
    "</td><td>" + keyStateBadge(k) + "</td><td>" + (k.request_count || 0) +
    "</td><td>" + fmtTime(k.created_at) + "</td></tr>"
  ).join("");
}

export function bindView() { /* 概览无静态绑定，数据在 enter 时加载 */ }

export async function enter() {
  if (!isAdmin()) return;
  await loadOverview();
  const keys = await loadKeys();
  renderOverview(keys);
}
