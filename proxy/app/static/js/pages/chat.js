/* 对话测试：密钥选择/回显、模型下拉、流式输出、消息工具条 */
import { api, isAdmin } from "../api.js";
import { esc, toast, renderMarkdown, copyToClipboard } from "../util.js";
import { store, loadKeys, loadUpstreams } from "../data.js";
import { switchView } from "../router.js";

let _chatModelOptions = [];  // 当前上下文可选模型（去重保序；选中密钥=其所属上游的模型，未选=全部）
let _chatModelOpen = false;  // 菜单是否展开
let _chatModelHl = -1;       // 键盘高亮项索引

let _chatMessages = [];
let _chatLoading = false;

let _chatSelectedKey = "";
let _chatAutoModel = "";     // 记录最后一次自动填充的模型名，便于切换密钥时随上游刷新

/* ===== 密钥列表（下拉可选：管理员全部可用 / 普通用户自己名下） ===== */
async function loadChatKeys() {
  const sel = document.getElementById("chat-key");
  if (!sel) return;
  const keys = await loadKeys();
  store.chatKeys = keys;
  // 已过期密钥不可再调用，不出现在对话可选列表
  const activeKeys = keys.filter((k) => k.status === "active" && !k.expired);
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

function currentChatKeyId() {
  const sel = document.getElementById("chat-key");
  const v = sel ? parseInt(sel.value, 10) : NaN;
  return Number.isNaN(v) ? 0 : v;
}

function upstreamOfKey(keyId) {
  const k = (store.chatKeys || []).find((x) => x.id === keyId);
  if (k && k.upstream_id) {
    const up = (store.upstreams || []).find((u) => u.id === k.upstream_id);
    if (up) return up;
  }
  return (store.upstreams || []).find((u) => u.is_default) || null;
}

function currentChatUpstream() {
  return upstreamOfKey(currentChatKeyId());
}

/* ===== 模型下拉（自定义 Combobox） =====
 * 候选 = 当前可用上游配置的模型名（去重保序），当前选中密钥所属上游的模型排在最前。
 * 原生 input+datalist 在输入框已有值时会把候选过滤到只剩前缀匹配的 1 项，因此用自绘下拉。 */
function collectChatModels(keyId) {
  const seen = new Set();
  const out = [];
  let ups = store.upstreams || [];
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

function updateChatModelList() {
  _chatModelOptions = collectChatModels(currentChatKeyId());
  if (_chatModelOpen) modelMenuRender(false);
}

function modelMenuRender(filterByInput = true) {
  const menu = document.getElementById("chat-model-menu");
  if (!menu) return;
  const input = document.getElementById("chat-model");
  const cur = (input && input.value || "").trim();
  const q = cur.toLowerCase();
  const up = currentChatUpstream();
  const pref = new Set(((up && up.models) || []).map((m) => String(m == null ? "" : m).trim()).filter(Boolean));
  const ordered = _chatModelOptions.slice().sort((a, b) => ((pref.has(a) ? 0 : 1) - (pref.has(b) ? 0 : 1)));
  // filterByInput=false（菜单打开时）：显示全部候选，不因输入框已有值被过滤
  const list = (filterByInput && q) ? ordered.filter((n) => n.toLowerCase().includes(q)) : ordered;

  menu.replaceChildren();
  if (!_chatModelOptions.length) {
    const p = document.createElement("div");
    p.className = "model-menu-empty";
    const selected = Boolean(currentChatKeyId());
    if (isAdmin()) {
      p.textContent = selected
        ? "当前密钥所属上游未配置模型，可到上游管理添加，或直接输入模型名"
        : "暂无可选模型：在上游管理中配置模型后即会出现在这里，也可以直接输入模型名";
    } else {
      p.textContent = selected
        ? "当前密钥所属上游未配置模型，可直接输入模型名"
        : "暂无可用模型（请先选择名下密钥，或直接输入模型名）";
    }
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
  modelMenuRender(false);
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
    _chatAutoModel = "";
  }
  modelMenuClose();
}

function chatFirstSuggestedModel() {
  const ups = store.upstreams || [];
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
  // 按密钥绑定的上游模型刷新模型输入：输入为空或仍等于上次自动填充值时刷新；手动输入不覆盖。
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

/* ===== 密钥切换：回显明文用于测试 ===== */
async function onChatKeyChange(e) {
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
      if (res.status === 410) {
        // 历史遗留密钥无明文：管理员可去重置；普通用户无权管理密钥，引导联系管理员
        const base = "该密钥无明文可回显（创建于明文回显功能上线之前或数据重建过）。";
        errEl.innerHTML = "";
        if (isAdmin()) {
          errEl.append("⚠ 密钥加载失败：" + base);
          const go = document.createElement("button");
          go.type = "button";
          go.className = "btn btn-ghost btn-sm";
          go.textContent = "去密钥管理重置";
          go.style.marginLeft = "8px";
          go.addEventListener("click", () => switchView("keys"));
          errEl.appendChild(go);
        } else {
          errEl.append("⚠ 密钥加载失败：" + base + " 请联系管理员重置密钥后重新分配给你。");
        }
        errEl.hidden = false;
        return;
      }
      if (errEl) { errEl.textContent = "⚠ 密钥加载失败：" + msg; errEl.hidden = false; }
    }
  } catch (e2) {
    if (errEl) { errEl.textContent = "⚠ 网络错误：" + e2.message; errEl.hidden = false; }
  }
  updateChatModelList();
  applyUpstreamModelsToChat(keyId);
}

/* ===== 聊天气泡渲染 / 工具条 ===== */
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
    bubble.classList.add("chat-bubble-md");

    const body = document.createElement("div");
    body.className = "chat-bubble-content";

    bubble.appendChild(body);
    bubble._contentEl = body;
    bubble._rawText = content || "";

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

    // 气泡外下方快捷操作栏
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
    actions._bubble = bubble;
    bubble._userMsgIndex = _chatMessages.length - 1;

    const col = document.createElement("div");
    col.className = "chat-col";
    col.appendChild(bubble);
    col.appendChild(actions);
    wrap.appendChild(avatar);
    wrap.appendChild(col);
  } else {
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

function getChatApiKey() {
  const mode = document.getElementById("chat-key-mode").value;
  if (mode === "manual") {
    return document.getElementById("chat-key-manual").value.trim();
  }
  return _chatSelectedKey || "";
}

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

async function _runChatRequest({ model, messages, temperature, stream, raw, apiKey, bubble }) {
  const payload = { model, messages, temperature, stream };
  if (stream) {
    // 让 Ollama / vLLM 等 OpenAI 兼容上游在流末尾上报 usage，网关才能记到 token 用量。
    // 对 Anthropic 方言上游该字段会被请求翻译层丢弃，无副作用。
    payload.stream_options = { include_usage: true };
  }
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

  const messages = _chatMessages.slice(0, bubble._userMsgIndex + 1);
  const oldRaw = bubble._rawText;
  const oldDom = bubble._contentEl.innerHTML;
  bubble.setTyping("正在重新生成");

  try {
    const full = await _runChatRequest({
      model, messages, temperature: temp, stream, raw: false, apiKey, bubble,
    });
    _chatMessages[bubble._userMsgIndex + 1] = { role: "assistant", content: full };
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
    if (box) box.scrollTop = box.scrollHeight;
  }
  return all;
}

async function readChatStream(res, bubble) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let done = false;
  let full = "";
  let started = false;
  let renderTimer = null;
  let lastRender = 0;
  const box = document.getElementById("chat-messages");
  const scroll = () => {
    if (box) box.scrollTop = box.scrollHeight;
  };

  const renderNow = (light) => {
    renderTimer = null;
    lastRender = Date.now();
    if (!bubble || !bubble.setMsg) return;
    bubble.setMsg(full, light ? { light: true } : {});
    scroll();
  };

  // 自适应渲染间隔：内容越长、单次全量解析越贵，间隔随之拉大
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
            started = true;
            lastRender = 0;
            renderNow(true);
          }
        }
      } catch { /* 忽略非 JSON 心跳行 */ }
    }
  }
  if (renderTimer) clearTimeout(renderTimer);
  renderNow(false);
  return full;
}

export function bindView(root) {
  const on = (id, evt, fn) => {
    const el = root.querySelector("#" + id);
    if (el) el.addEventListener(evt, fn);
  };

  // 模型下拉交互
  const input = root.querySelector("#chat-model");
  const caret = root.querySelector("#chat-model-caret");
  const picker = root.querySelector("#model-picker");
  if (input && caret && picker) {
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
      else if (e.key === "Enter" && _chatModelOpen && _chatModelHl >= 0) { e.preventDefault(); pickChatModel(root.querySelector("#chat-model-menu .model-menu-item.hl").dataset.model); }
      else if (e.key === "Escape" && _chatModelOpen) { e.preventDefault(); modelMenuClose(); }
    });
    input.addEventListener("blur", () => {
      setTimeout(() => { if (_chatModelOpen) modelMenuClose(); }, 160);
    });
    document.addEventListener("click", (e) => {
      if (_chatModelOpen && !picker.contains(e.target)) modelMenuClose();
    });
  }

  on("chat-key-mode", "change", (e) => {
    const mode = e.target.value;
    document.getElementById("chat-key-select-wrap").hidden = mode !== "select";
    document.getElementById("chat-key-manual-wrap").hidden = mode !== "manual";
  });
  on("chat-key", "change", onChatKeyChange);
  on("chat-clear-ctx", "click", clearChat);

  const messagesBox = root.querySelector("#chat-messages");
  if (messagesBox) messagesBox.addEventListener("click", handleChatClick);
  on("chat-send", "click", sendChat);
  on("chat-input", "keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
}

export async function enter() {
  await loadChatKeys();
  await loadUpstreams();
  fillChatModelDefault();
}
