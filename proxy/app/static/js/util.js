/* 共享工具：DOM 渲染、格式化、Toast、Markdown 等（无业务依赖） */

export function toast(msg, type = "") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "toast show " + type;
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.hidden = true; el.className = "toast"; }, 2600);
}

export function openModal(id) { const el = document.getElementById(id); if (el) el.hidden = false; }
export function closeModal(id) { const el = document.getElementById(id); if (el) el.hidden = true; }

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function fmtTime(s) {
  if (!s) return "—";
  try {
    const d = new Date(s);
    if (isNaN(d)) return esc(s);
    return d.toLocaleString("zh-CN", { hour12: false });
  } catch { return esc(s); }
}

export function fmtNum(n) {
  /* 大数字缩写：12.3k / 1.25M；<1e4 显示完整整数 */
  n = Number(n) || 0;
  const neg = n < 0 ? "-" : "";
  n = Math.abs(n);
  const cut = (x, d) => String(x.toFixed(d)).replace(/\.?0+$/, "");
  if (n >= 1e9) return neg + cut(n / 1e9, 2) + "B";
  if (n >= 1e6) return neg + cut(n / 1e6, 2) + "M";
  if (n >= 1e4) return neg + cut(n / 1e3, 1) + "k";
  if (n >= 1e3) return neg + cut(n / 1e3, 2) + "k";
  return neg + String(Math.round(n));
}

export function badge(status) {
  const cls = status === "active" ? "badge-active" : "badge-revoked";
  const text = status === "active" ? "活跃" : "已吊销";
  return '<span class="badge ' + cls + '">' + text + "</span>";
}

/* 状态列（派生状态，DB 仍是 active，重置/吊销等操作不受影响）：
 * 已过期 → 不活跃（>7 天未使用）→ 按 DB 状态显示 */
export function keyStateBadge(k) {
  if (k && k.expired) {
    return '<span class="badge badge-expired" title="已超过设置的过期时间，调用将被网关拒绝">已过期</span>';
  }
  if (k && k.inactive) {
    return '<span class="badge badge-inactive" title="超过 7 天未使用，密钥仍可正常使用">不活跃</span>';
  }
  return badge(k && k.status);
}

export function roleBadge(role) {
  if (role === "admin") {
    return '<span class="badge" style="background: rgba(99,102,241,.15); color: var(--primary);">管理员</span>';
  }
  return '<span class="badge" style="background: rgba(148,163,184,.15); color: var(--text-dim);">普通用户</span>';
}

export function renderMarkdown(md, opts) {
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

export async function copyToClipboard(text, btn) {
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

/* 在给定 DOM 范围内为 [data-close] 按钮与 .modal-mask 绑定“关闭所在 modal”。
 * 每个视图片段首次挂载时对自身子树调用一次，避免重复监听。 */
export function bindModalDismiss(root) {
  root.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => {
      const m = el.closest(".modal");
      if (m) m.hidden = true;
    });
  });
  root.querySelectorAll(".modal-mask").forEach((el) => {
    el.addEventListener("click", () => { el.closest(".modal").hidden = true; });
  });
}
