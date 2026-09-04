/* 上游管理：列表渲染、添加/编辑/删除（仅管理员） */
import { api } from "../api.js";
import { esc, fmtTime, toast, openModal, closeModal, bindModalDismiss } from "../util.js";
import { store, loadUpstreams } from "../data.js";

function modelsHtml(models) {
  const list = (Array.isArray(models) ? models : []).filter((m) => String(m).trim());
  if (!list.length) return '<span class="muted">—</span>';
  return list.map((m) => '<span class="badge badge-model">' + esc(String(m).trim()) + "</span>").join(" ");
}

function renderUpstreams(ups) {
  const tb = document.getElementById("upstreams-tbody");
  if (!ups.length) {
    tb.innerHTML = '<tr><td colspan="9" class="muted">暂无上游配置</td></tr>';
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
      <td>${u.inject_include_usage ? '<span class="badge badge-usage" title="流式请求自动补 stream_options.include_usage，取回 token 用量">注入中</span>' : '<span class="muted">—</span>'}</td>
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

function resetModalFields() {
  document.getElementById("upstream-modal-title").textContent = "添加上游";
  document.getElementById("upstream-edit-id").value = "";
  document.getElementById("upstream-name").value = "";
  document.getElementById("upstream-base-url").value = "";
  document.getElementById("upstream-models").value = "";
  document.getElementById("upstream-api-key").value = "";
  document.getElementById("upstream-protocol").value = "openai";
  document.getElementById("upstream-is-default").checked = false;
  document.getElementById("upstream-inject-usage").checked = false;
  openModal("modal-upstream");
}

function openEditUpstream(id) {
  const up = (store.upstreams || []).find((u) => u.id === id);
  if (!up) return;
  document.getElementById("upstream-modal-title").textContent = "编辑上游";
  document.getElementById("upstream-edit-id").value = up.id;
  document.getElementById("upstream-name").value = up.name;
  document.getElementById("upstream-base-url").value = up.base_url;
  document.getElementById("upstream-models").value = (up.models || []).join("\n");
  document.getElementById("upstream-api-key").value = up.api_key || "";
  document.getElementById("upstream-protocol").value = up.protocol || "openai";
  document.getElementById("upstream-is-default").checked = !!up.is_default;
  document.getElementById("upstream-inject-usage").checked = !!up.inject_include_usage;
  openModal("modal-upstream");
}

async function submitUpstream() {
  const id = document.getElementById("upstream-edit-id").value;
  const name = document.getElementById("upstream-name").value.trim();
  const baseUrl = document.getElementById("upstream-base-url").value.trim();
  const apiKey = document.getElementById("upstream-api-key").value;
  const protocol = document.getElementById("upstream-protocol").value || "openai";
  const isDefault = document.getElementById("upstream-is-default").checked;
  const injectIncludeUsage = document.getElementById("upstream-inject-usage").checked;
  const models = document.getElementById("upstream-models").value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!name) { toast("请输入上游名称", "error"); return; }
  if (!baseUrl) { toast("请输入上游地址", "error"); return; }

  try {
    let res;
    const body = { name, base_url: baseUrl, api_key: apiKey, protocol, is_default: isDefault, models, inject_include_usage: injectIncludeUsage };
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
      await reloadUpstreamsView();
    } else {
      const errData = await res.json().catch(() => ({}));
      toast(errData.detail || "操作失败 (" + res.status + ")", "error");
    }
  } catch (e) { toast("操作失败：" + e.message, "error"); }
}

async function deleteUpstream(id) {
  if (!confirm("确定删除该上游？删除后绑定该上游的密钥将使用默认上游。")) return;
  try {
    const res = await api("/admin/upstreams/" + id, { method: "DELETE" });
    if (res.ok) { toast("已删除", "success"); await reloadUpstreamsView(); }
    else {
      const errData = await res.json().catch(() => ({}));
      toast(errData.detail || "删除失败 (" + res.status + ")", "error");
    }
  } catch (e) { toast("删除失败：" + e.message, "error"); }
}

async function reloadUpstreamsView() {
  const ups = await loadUpstreams();
  renderUpstreams(ups);
}

export function bindView(root) {
  bindModalDismiss(root);
  const on = (id, evt, fn) => {
    const el = root.querySelector("#" + id);
    if (el) el.addEventListener(evt, fn);
  };
  on("create-upstream-btn", "click", resetModalFields);
  on("upstream-submit", "click", submitUpstream);
}

export async function enter() {
  await reloadUpstreamsView();
}
