/* 密钥管理：列表渲染、新建（归属/过期）、改名、设置归属、重置、吊销 */
import { api, isAdmin } from "../api.js";
import {
  esc, fmtTime, keyStateBadge, toast, openModal, closeModal, bindModalDismiss,
} from "../util.js";
import { store, loadKeys, loadUpstreams, getUpstreamName } from "../data.js";

/* 归属用户下拉（管理员新建/转移密钥归属用） */
async function populateOwnerOptions(sel, selectedId) {
  // 保留第一个“不归属（系统密钥）”占位选项
  const placeholder = sel.options[0];
  sel.replaceChildren();
  if (placeholder) sel.appendChild(placeholder);
  let users = [];
  try {
    const res = await api("/admin/users");
    if (res.ok) users = await res.json();
  } catch (e) { /* 拉取失败则仅剩占位选项 */ }
  users.forEach((u) => {
    if (u.role !== "viewer") return;
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = u.username + "（普通用户）";
    if (String(u.id) === String(selectedId)) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderKeys(keys) {
  const tb = document.getElementById("keys-tbody");
  const admin = isAdmin();
  store.keys = keys;
  if (!keys.length) {
    const cols = admin ? 11 : 9;
    tb.innerHTML = '<tr><td colspan="' + cols + '" class="muted">暂无密钥</td></tr>';
    return;
  }
  tb.innerHTML = keys.map((k) => {
    const ownerHtml = k.owner_name
      ? esc(k.owner_name) + ' <span class="muted">#' + k.owner_id + "</span>"
      : '<span class="muted">系统</span>';
    let html = "<tr><td>" + k.id + "</td><td>" + esc(k.key_prefix) + "</td><td>" + esc(k.name || "—") +
      "</td><td>" + esc(getUpstreamName(k.upstream_id)) + "</td>" +
      '<td class="admin-only">' + ownerHtml + "</td>" +
      "<td>" + keyStateBadge(k) + "</td><td>" + fmtTime(k.created_at) +
      "</td><td>" + fmtTime(k.expires_at) + "</td><td>" + fmtTime(k.last_used_at) +
      "</td><td>" + (k.request_count || 0) + "</td>";
    if (admin) {
      html += '<td>' +
        '<button class="btn btn-ghost btn-sm" data-owner-key="' + k.id + '" title="设置/转移密钥归属用户">归属</button>' +
        '<button class="btn btn-ghost btn-sm" data-edit-key="' + k.id + '" title="修改备注名称">编辑</button>' +
        (k.status === "active"
          ? '<button class="btn btn-ghost btn-sm" data-reset="' + k.id + '" title="生成新密钥替换旧值，旧 key 立即失效">重置</button>' +
            '<button class="btn btn-danger btn-sm" data-revoke="' + k.id + '">吊销</button>'
          : "") + "</td>";
    }
    html += "</tr>";
    return html;
  }).join("");

  tb.querySelectorAll("[data-owner-key]").forEach((btn) => {
    btn.addEventListener("click", () => openSetOwner(parseInt(btn.dataset.ownerKey, 10)));
  });
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

async function reloadKeysView() {
  const keys = await loadKeys();
  renderKeys(keys);
}

/* ---------- 新建密钥弹窗 ---------- */

/* 过期时间的日期/时间双框：有日期才显示"清除"，清除后置空 */
function updateExpiresClearBtn() {
  const clearBtn = document.getElementById("create-expires-clear");
  const hasDate = !!document.getElementById("create-expires-date").value;
  if (clearBtn) clearBtn.hidden = !hasDate;
}

async function openCreateModal() {
  document.getElementById("create-name").value = "";
  document.getElementById("create-expires-date").value = "";
  document.getElementById("create-expires-time").value = "";
  updateExpiresClearBtn();
  const sel = document.getElementById("create-upstream");
  sel.innerHTML = '<option value="">默认上游</option>';
  (store.upstreams || []).forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = u.name + (u.is_default ? " (默认)" : "");
    sel.appendChild(opt);
  });
  const ownerSel = document.getElementById("create-owner");
  ownerSel.innerHTML = '<option value="">不归属（系统密钥，仅管理员可见）</option>';
  await populateOwnerOptions(ownerSel, "");
  openModal("modal-create");
}

async function submitCreate() {
  const name = document.getElementById("create-name").value.trim() || null;
  const dateVal = document.getElementById("create-expires-date").value.trim();
  const timeVal = document.getElementById("create-expires-time").value.trim();
  let expires = null;
  if (dateVal) {
    // date/time 均按浏览器本地时区解析；仅选日期未选时间则默认当天 23:59
    const d = new Date(dateVal + "T" + (timeVal || "23:59"));
    if (isNaN(d)) { toast("过期时间格式无效", "error"); return; }
    // 存为 +00:00 形式的 UTC，兼容 Python 3.10 的 datetime.fromisoformat（不识别末尾 Z）
    expires = d.toISOString().replace(/Z$/, "+00:00");
  }
  const upstreamId = document.getElementById("create-upstream").value;
  try {
    const body = { name, expires_at: expires };
    if (upstreamId) body.upstream_id = parseInt(upstreamId, 10);
    const ownerId = document.getElementById("create-owner").value;
    if (ownerId) body.owner_id = parseInt(ownerId, 10);
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
    reloadKeysView();
  } catch (e) { toast("创建失败：" + e.message, "error"); }
}

async function copyKeyText() {
  const txt = document.getElementById("new-key-text").textContent;
  try { await navigator.clipboard.writeText(txt); toast("已复制到剪贴板", "success"); }
  catch { toast("复制失败，请手动选择", "error"); }
}

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
    reloadKeysView();
  } catch (e) { toast("重置失败：" + e.message, "error"); }
}

async function revokeKey(id) {
  if (!confirm("确定吊销该密钥？吊销后无法恢复，使用该 key 的调用将立即失败。")) return;
  try {
    const res = await api("/admin/keys/" + id, { method: "DELETE" });
    if (res.ok) { toast("已吊销", "success"); reloadKeysView(); }
    else if (res.status === 403) { toast("权限不足", "error"); }
    else { toast("吊销失败 (" + res.status + ")", "error"); }
  } catch (e) { toast("吊销失败：" + e.message, "error"); }
}

/* ---------- 编辑名称 / 设置归属 ---------- */

function openRenameKey(id) {
  const k = store.keys.find((x) => x.id === id);
  if (!k) return;
  document.getElementById("key-rename-id").value = k.id;
  document.getElementById("key-rename-name").value = k.name || "";
  document.getElementById("key-rename-prefix").textContent = k.key_prefix;
  openModal("modal-key-rename");
}

async function submitRename() {
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
    reloadKeysView();
  } catch (e) { toast("保存失败：" + e.message, "error"); }
}

function openSetOwner(keyId) {
  const k = store.keys.find((x) => x.id === keyId);
  if (!k) return;
  document.getElementById("key-owner-id").value = k.id;
  document.getElementById("key-owner-prefix").textContent = k.key_prefix;
  const sel = document.getElementById("key-owner");
  sel.innerHTML = '<option value="">不归属（系统密钥，仅管理员可见）</option>';
  populateOwnerOptions(sel, k.owner_id);
  openModal("modal-key-owner");
}

async function submitOwner() {
  const id = parseInt(document.getElementById("key-owner-id").value, 10);
  if (!id) return;
  const ownerVal = document.getElementById("key-owner").value;
  const ownerId = ownerVal ? parseInt(ownerVal, 10) : null;
  try {
    const res = await api("/admin/keys/" + id + "/owner", {
      method: "PATCH",
      body: JSON.stringify({ owner_id: ownerId }),
    });
    if (res.ok) {
      closeModal("modal-key-owner");
      toast("归属已更新", "success");
      reloadKeysView();
    } else {
      const err = await res.json().catch(() => ({}));
      toast(err.detail || ("保存失败 (" + res.status + ")"), "error");
    }
  } catch (e) { toast("保存失败：" + e.message, "error"); }
}

export function bindView(root) {
  bindModalDismiss(root);
  const on = (id, evt, fn) => {
    const el = root.querySelector("#" + id);
    if (el) el.addEventListener(evt, fn);
  };
  on("create-key-btn", "click", openCreateModal);
  on("create-expires-date", "change", updateExpiresClearBtn);
  on("create-expires-clear", "click", () => {
    document.getElementById("create-expires-date").value = "";
    document.getElementById("create-expires-time").value = "";
    updateExpiresClearBtn();
  });
  on("create-submit", "click", submitCreate);
  on("copy-key", "click", copyKeyText);
  on("key-rename-submit", "click", submitRename);
  on("key-owner-submit", "click", submitOwner);
}

export async function enter() {
  if (!isAdmin()) return;
  await loadUpstreams();       // 用于“上游”列与新建弹窗下拉
  await reloadKeysView();
}
