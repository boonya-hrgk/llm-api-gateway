/* 用户管理：列表渲染、新建/编辑/删除（仅管理员） */
import { api, getCurrentUser } from "../api.js";
import { esc, fmtTime, roleBadge, toast, openModal, closeModal, bindModalDismiss } from "../util.js";

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
    const tb = document.getElementById("users-tbody");
    if (tb) tb.innerHTML = '<tr><td colspan="6" class="muted">加载失败</td></tr>';
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

function openCreateUser() {
  document.getElementById("user-modal-title").textContent = "新建用户";
  document.getElementById("user-edit-id").value = "";
  document.getElementById("user-username").value = "";
  document.getElementById("user-username").disabled = false;
  document.getElementById("user-password").value = "";
  document.getElementById("user-password").placeholder = "请输入密码";
  document.getElementById("user-password-hint").style.display = "none";
  document.getElementById("user-role").value = "viewer";
  openModal("modal-user");
}

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

async function submitUser() {
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
    } else {
      const errData = await res.json().catch(() => ({}));
      toast(errData.detail || "操作失败 (" + res.status + ")", "error");
    }
  } catch (e) { toast("操作失败：" + e.message, "error"); }
}

async function deleteUser(id) {
  if (!confirm("确定删除该用户？删除后无法恢复。")) return;
  try {
    const res = await api("/admin/users/" + id, { method: "DELETE" });
    if (res.ok) { toast("已删除", "success"); loadUsers(); }
    else {
      const errData = await res.json().catch(() => ({}));
      toast(errData.detail || "删除失败 (" + res.status + ")", "error");
    }
  } catch (e) { toast("删除失败：" + e.message, "error"); }
}

export function bindView(root) {
  bindModalDismiss(root);
  const on = (id, evt, fn) => {
    const el = root.querySelector("#" + id);
    if (el) el.addEventListener(evt, fn);
  };
  on("create-user-btn", "click", openCreateUser);
  on("user-submit", "click", submitUser);
}

export async function enter() {
  await loadUsers();
}
