"""Anthropic Messages API <-> OpenAI Chat Completions 双向协议翻译层。

网关保持「入口自动识别方言，转发按上游协议选择」：

- 入口是 OpenAI 方言（/v1/chat/completions、对话测试页、OpenAI SDK），上游是 anthropic → 走 O→A 翻译；
- 入口是 Anthropic 方言（/v1/messages、Claude Code / cc-switch 直连），上游是 openai → 走 A→O 翻译；
- 同方言则原样透传。

覆盖：请求体、非流式响应、SSE 流式事件（含 tools / tool_calls / tool_use / tool_result、
system 消息、image 块），以及常见错误体的转换。图片块仅透传文本描述不丢内容结构。
"""
from __future__ import annotations

import json
import time
from typing import Optional

# Anthropic 请求必填 max_tokens；OpenAI 请求常缺省，翻译时兜底
DEFAULT_MAX_TOKENS = 4096

_ANTHROPIC_VERSION = "2023-06-01"

# ---------- 通用小工具 ----------


def _now_created() -> int:
    return int(time.time())


def _text_of(content) -> str:
    """把 OpenAI / Anthropic 消息 content（str 或 parts/blocks）压成纯文本。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts: list[str] = []
    if isinstance(content, list):
        for blk in content:
            if isinstance(blk, dict):
                if blk.get("type") in ("text",):
                    parts.append(str(blk.get("text", "")))
                elif blk.get("type") == "image_url":
                    parts.append("[图片]")
                elif blk.get("type") == "image":
                    parts.append("[图片]")
                elif blk.get("type") == "tool_result":
                    parts.append(_text_of(blk.get("content")))
            else:
                parts.append(str(blk))
    return "".join(parts)


def _to_text_blocks(content) -> Optional[str]:
    """OpenAI content parts（text/image_url）转字符串，图片占位。"""
    if content is None or isinstance(content, str):
        return content
    if isinstance(content, list):
        return _text_of(content)
    return str(content)


# ---------- tools / tool_choice 转换 ----------


def _anthropic_tools_to_openai(tools) -> Optional[list[dict]]:
    if not tools:
        return None
    out = []
    for t in tools:
        if not isinstance(t, dict):
            continue
        fn = {
            "name": t.get("name", ""),
            "description": t.get("description", ""),
            "parameters": t.get("input_schema") or t.get("parameters") or {"type": "object", "properties": {}},
        }
        out.append({"type": "function", "function": fn})
    return out or None


def _openai_tools_to_anthropic(tools) -> Optional[list[dict]]:
    if not tools:
        return None
    out = []
    for t in tools:
        if not isinstance(t, dict):
            continue
        fn = t.get("function", {})
        out.append({
            "name": fn.get("name", ""),
            "description": fn.get("description", ""),
            "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
        })
    return out or None


def _anthropic_tool_choice_to_openai(tc) -> object:
    if isinstance(tc, str):
        return {"auto": "auto", "any": "required", "none": "none"}.get(tc, "auto")
    if isinstance(tc, dict):
        typ = tc.get("type")
        if typ == "tool" and tc.get("name"):
            return {"type": "function", "function": {"name": tc["name"]}}
        if typ == "any":
            return "required"
        if typ == "none":
            return "none"
    return "auto"


def _openai_tool_choice_to_anthropic(tc) -> dict:
    if isinstance(tc, str):
        return {"auto": {"type": "auto"}, "required": {"type": "any"}, "none": {"type": "none"}}.get(
            tc, {"type": "auto"}
        )
    if isinstance(tc, dict):
        if tc.get("type") == "function":
            name = (tc.get("function") or {}).get("name")
            if name:
                return {"type": "tool", "name": name}
            return {"type": "auto"}
    return {"type": "auto"}


# =========================================================
#  请求体翻译
# =========================================================

def anthropic_to_openai_req(body: dict) -> dict:
    """Anthropic /v1/messages 请求体 → OpenAI /v1/chat/completions 请求体。"""
    out_msgs: list[dict] = []

    # system 支持 str 或 [{type:text,text}]，展成一条 system 消息（OpenAI 兼容实现普遍接受）
    sys_text = _extract_system_text(body.get("system"))
    if sys_text:
        out_msgs.append({"role": "system", "content": sys_text})

    for msg in body.get("messages") or []:
        role = msg.get("role")
        content = msg.get("content")
        if isinstance(content, str):
            out_msgs.append({"role": role, "content": content})
            continue
        blocks = content or []
        text_parts: list[str] = []
        image_parts: list[dict] = []
        tool_calls: list[dict] = []
        tool_results: list[dict] = []
        for blk in blocks:
            if not isinstance(blk, dict):
                continue
            typ = blk.get("type")
            if typ == "text":
                text_parts.append(str(blk.get("text", "")))
            elif typ == "image":
                src = blk.get("source", {}) or {}
                if src.get("type") == "base64":
                    media = src.get("media_type", "image/png")
                    image_parts.append({
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{media};base64,{src.get('data', '')}"
                        },
                    })
                elif src.get("type") == "url":
                    image_parts.append({"type": "image_url", "image_url": {"url": src.get("url", "")}})
            elif typ == "tool_use":
                tool_calls.append({
                    "id": blk.get("id", ""),
                    "type": "function",
                    "function": {
                        "name": blk.get("name", ""),
                        "arguments": json.dumps(blk.get("input", {}), ensure_ascii=False),
                    },
                })
            elif typ == "tool_result":
                tool_results.append(blk)

        # 文本 + 图片统一为 content
        has_image = bool(image_parts)
        if has_image:
            parts: list[dict] = []
            if text_parts:
                parts.append({"type": "text", "text": "".join(text_parts)})
            parts.extend(image_parts)
            content_value = parts
        else:
            content_value = "".join(text_parts) if text_parts else None

        if role == "user":
            if tool_results:
                # Anthropic 把 tool_result 装在 user 消息里 → OpenAI 拆成多条 role=tool 消息
                for tr in tool_results:
                    res_text = _text_of(tr.get("content"))
                    if tr.get("is_error"):
                        res_text = f"[错误] {res_text}"
                    out_msgs.append({
                        "role": "tool",
                        "tool_call_id": tr.get("tool_use_id", ""),
                        "content": res_text,
                    })
                if content_value:
                    out_msgs.append({"role": "user", "content": content_value})
            else:
                out_msgs.append({"role": "user", "content": content_value})
        elif role == "assistant":
            if tool_calls:
                out_msgs.append({
                    "role": "assistant",
                    "content": content_value,
                    "tool_calls": tool_calls,
                })
            else:
                out_msgs.append({"role": "assistant", "content": content_value})

    result: dict = {}
    if body.get("model"):
        result["model"] = body["model"]
    result["messages"] = out_msgs
    if body.get("max_tokens") is not None:
        result["max_tokens"] = body["max_tokens"]
    if body.get("temperature") is not None:
        result["temperature"] = body["temperature"]
    if body.get("top_p") is not None:
        result["top_p"] = body["top_p"]
    stop = body.get("stop_sequences")
    if stop:
        result["stop"] = stop if isinstance(stop, list) else [stop]
    tools = _anthropic_tools_to_openai(body.get("tools"))
    if tools:
        result["tools"] = tools
    if body.get("tool_choice"):
        result["tool_choice"] = _anthropic_tool_choice_to_openai(body["tool_choice"])
    if body.get("stream") is not None:
        result["stream"] = body["stream"]
    # OpenAI 上游默认流式响应不返回 usage；强制 include_usage 以便网关统计 token。
    # 仅对翻译出站（Anthropic→OpenAI）生效，兼容实现普遍接受该字段。
    if result.get("stream") and isinstance(result["stream"], bool) and result["stream"]:
        result.setdefault("stream_options", {"include_usage": True})
    return result


def openai_to_anthropic_req(body: dict) -> dict:
    """OpenAI /v1/chat/completions 请求体 → Anthropic /v1/messages 请求体。"""
    raw_msgs = body.get("messages") or []
    sys_parts: list[str] = []
    out_msgs: list[dict] = []

    i = 0
    n = len(raw_msgs)
    while i < n:
        msg = raw_msgs[i]
        role = msg.get("role", "")
        content = msg.get("content")

        # role=tool 的消息 → 连续收集为一个 Anthropic user 消息里的多个 tool_result 块
        if role == "tool":
            blocks: list[dict] = []
            while i < n and raw_msgs[i].get("role") == "tool":
                m = raw_msgs[i]
                blocks.append({
                    "type": "tool_result",
                    "tool_use_id": m.get("tool_call_id", ""),
                    "content": _text_of(m.get("content")),
                })
                i += 1
            if blocks:
                out_msgs.append({"role": "user", "content": blocks})
            continue

        if role in ("system", "developer"):
            sys_parts.append(_text_of(content))
            i += 1
            continue

        if role == "assistant":
            tool_calls = msg.get("tool_calls")
            if tool_calls:
                content_blocks: list[dict] = []
                text = _text_of(content)
                if text:
                    content_blocks.append({"type": "text", "text": text})
                for tc in tool_calls:
                    fn = tc.get("function", {}) or {}
                    raw_args = fn.get("arguments") or "{}"
                    try:
                        args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                    except (json.JSONDecodeError, TypeError):
                        args = {"_raw": raw_args}
                    content_blocks.append({
                        "type": "tool_use",
                        "id": tc.get("id", ""),
                        "name": fn.get("name", ""),
                        "input": args,
                    })
                out_msgs.append({"role": "assistant", "content": content_blocks})
            else:
                text = content if isinstance(content, str) else _to_text_blocks(content)
                out_msgs.append({"role": "assistant", "content": text if text is not None else ""})
        elif role == "user":
            if isinstance(content, str):
                out_msgs.append({"role": "user", "content": content})
            else:
                blocks = []
                for part in content or []:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") == "image_url":
                        url = (part.get("image_url") or {}).get("url", "")
                        if url.startswith("data:"):
                            try:
                                meta, b64 = url.split(",", 1)
                                media = meta.split(";")[0].replace("data:", "", 1) or "image/png"
                                blocks.append({
                                    "type": "image",
                                    "source": {"type": "base64", "media_type": media, "data": b64},
                                })
                            except ValueError:
                                pass
                        else:
                            blocks.append({
                                "type": "image",
                                "source": {"type": "url", "url": url},
                            })
                    else:
                        txt = part.get("text", "")
                        if txt:
                            blocks.append({"type": "text", "text": txt})
                out_msgs.append({"role": "user", "content": blocks if blocks else ""})
        else:
            # 未知 role 保守放行文本
            out_msgs.append({"role": "user", "content": _text_of(content)})
        i += 1

    result: dict = {}
    if body.get("model"):
        result["model"] = body["model"]
    result["messages"] = out_msgs
    # Anthropic 必填 max_tokens
    result["max_tokens"] = (
        body.get("max_tokens")
        or body.get("max_completion_tokens")
        or DEFAULT_MAX_TOKENS
    )
    if sys_parts:
        result["system"] = "\n".join(p for p in sys_parts if p)
    if body.get("temperature") is not None:
        result["temperature"] = body["temperature"]
    if body.get("top_p") is not None:
        result["top_p"] = body["top_p"]
    stop = body.get("stop")
    if stop:
        result["stop_sequences"] = stop if isinstance(stop, list) else [stop]
    tools = _openai_tools_to_anthropic(body.get("tools"))
    if tools:
        result["tools"] = tools
    if body.get("tool_choice"):
        result["tool_choice"] = _openai_tool_choice_to_anthropic(body["tool_choice"])
    if body.get("stream") is not None:
        result["stream"] = body["stream"]
    return result


def _extract_system_text(system) -> str:
    if not system:
        return ""
    if isinstance(system, str):
        return system
    if isinstance(system, list):
        return "\n".join(str(b.get("text", "")) for b in system if isinstance(b, dict))
    return str(system)


# =========================================================
#  非流式响应翻译
# =========================================================

_STOP_ANTHROPIC_TO_OPENAI = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "tool_use": "tool_calls",
    "refusal": "content_filter",
}
_STOP_OPENAI_TO_ANTHROPIC = {
    "stop": "end_turn",
    "length": "max_tokens",
    "tool_calls": "tool_use",
    "content_filter": "refusal",
}


def anthropic_to_openai_resp(resp: dict) -> dict:
    """Anthropic 完整响应（非流式）→ OpenAI 完整响应。"""
    content = resp.get("content") or []
    text_parts: list[str] = []
    tool_calls: list[dict] = []
    for blk in content:
        if not isinstance(blk, dict):
            continue
        if blk.get("type") == "text":
            text_parts.append(str(blk.get("text", "")))
        elif blk.get("type") == "tool_use":
            tool_calls.append({
                "id": blk.get("id", ""),
                "type": "function",
                "function": {
                    "name": blk.get("name", ""),
                    "arguments": json.dumps(blk.get("input", {}), ensure_ascii=False),
                },
            })

    text = "".join(text_parts)
    usage = resp.get("usage") or {}
    input_tokens = usage.get("input_tokens") or usage.get("cache_read_input_tokens") or 0
    output_tokens = usage.get("output_tokens") or 0
    msg: dict = {"role": "assistant"}
    if text:
        msg["content"] = text
    elif tool_calls:
        msg["content"] = None
    else:
        msg["content"] = ""
    if tool_calls:
        msg["tool_calls"] = tool_calls

    return {
        "id": resp.get("id") or f"chatcmpl-{_now_created()}",
        "object": "chat.completion",
        "created": _now_created(),
        "model": resp.get("model", ""),
        "choices": [{
            "index": 0,
            "message": msg,
            "finish_reason": _STOP_ANTHROPIC_TO_OPENAI.get(resp.get("stop_reason", ""), "stop"),
        }],
        "usage": {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        },
    }


def openai_to_anthropic_resp(resp: dict) -> dict:
    """OpenAI 完整响应（非流式）→ Anthropic 完整响应。"""
    choice = (resp.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content_blocks: list[dict] = []
    content = msg.get("content")
    text = _text_of(content)
    if text:
        content_blocks.append({"type": "text", "text": text})

    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function", {}) or {}
        raw_args = fn.get("arguments") or "{}"
        try:
            args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        except (json.JSONDecodeError, TypeError):
            args = {"_raw": raw_args}
        content_blocks.append({
            "type": "tool_use",
            "id": tc.get("id", ""),
            "name": fn.get("name", ""),
            "input": args,
        })

    usage = resp.get("usage") or {}
    prompt_tokens = usage.get("prompt_tokens") or 0
    completion_tokens = usage.get("completion_tokens") or 0
    return {
        "id": resp.get("id") or f"msg_{_now_created()}",
        "type": "message",
        "role": "assistant",
        "model": resp.get("model", ""),
        "content": content_blocks,
        "stop_reason": _STOP_OPENAI_TO_ANTHROPIC.get(choice.get("finish_reason", ""), "end_turn"),
        "stop_sequence": None,
        "usage": {
            "input_tokens": prompt_tokens,
            "output_tokens": completion_tokens,
        },
    }


# =========================================================
#  SSE 解析：字节流 → (event, data) 事件序列
# =========================================================


def _parse_sse_segment(seg: str):
    event: Optional[str] = None
    data_lines: list[str] = []
    for line in seg.split("\n"):
        if line.startswith("event:"):
            event = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:"):].lstrip(" "))
        # 忽略注释(: ...)与其它字段
    if not data_lines:
        return None
    return (event, "\n".join(data_lines))


class SSEBuffer:
    """把上游 SSE 字节流按空行边界切分成完整事件，容忍跨 chunk 的分片。

    产出 (event_type, data_str) 元组；OpenAI 流无 event 行，event 为 None。
    """

    def __init__(self) -> None:
        self._buf = b""

    def feed(self, chunk: bytes):
        self._buf += chunk
        text = self._buf.replace(b"\r\n", b"\n").decode("utf-8", errors="replace")
        parts = text.split("\n\n")
        events = []
        if len(parts) > 1:
            self._buf = parts[-1].encode("utf-8")
            for seg in parts[:-1]:
                ev = _parse_sse_segment(seg)
                if ev is not None:
                    events.append(ev)
        return events

    def flush(self):
        events = []
        text = self._buf.replace(b"\r\n", b"\n").decode("utf-8", errors="replace").strip()
        self._buf = b""
        if text:
            ev = _parse_sse_segment(text)
            if ev is not None:
                events.append(ev)
        return events


def _sse_event(event: Optional[str], data: dict | str) -> bytes:
    """构造一段 SSE 文本。Anthropic 需要 event: 行；OpenAI 只有 data: 行。"""
    if isinstance(data, (dict, list)):
        data = json.dumps(data, ensure_ascii=False)
    out = ""
    if event:
        out += f"event: {event}\n"
    out += f"data: {data}\n\n"
    return out.encode("utf-8")


# =========================================================
#  usage（token 用量）解析：网关统计口径，非客户端可见值
# =========================================================


def openai_usage_of(data: dict):
    """从任意 OpenAI 响应（完整响应或流式 chunk）取 (input, output, cache_read)；无 usage 返回 None。

    OpenAI 的 usage 字段在非流式响应与 stream_options=include_usage 的末块中出现，
    字段名 prompt_tokens / completion_tokens。缓存命中量在
    usage.prompt_tokens_details.cached_tokens（包含在 prompt_tokens 之内）。
    """
    usage = data.get("usage") or {}
    if not isinstance(usage, dict):
        return None
    prompt = usage.get("prompt_tokens")
    completion = usage.get("completion_tokens")
    if prompt is None and completion is None:
        return None
    details = usage.get("prompt_tokens_details") or {}
    cached = details.get("cached_tokens") if isinstance(details, dict) else None
    return (prompt or 0, completion or 0, cached or 0)


def anthropic_usage_of(data: dict):
    """从 Anthropic 响应/消息取 (input, output, cache_read)；无 usage 返回 None。

    输入口径包含缓存读/写：input_tokens + cache_read_input_tokens +
    cache_creation_input_tokens（这三段互不重叠，共同构成真实输入消耗）。
    第三元 cache_read 单独返回缓存命中读取量（计入第一元，供统计页单独展示）。
    无任何 token 字段时返回 None（上游未上报）。
    """
    usage = data.get("usage") or {}
    if not isinstance(usage, dict):
        return None
    inp = usage.get("input_tokens")
    out = usage.get("output_tokens")
    cache_read = usage.get("cache_read_input_tokens") or 0
    cache_write = usage.get("cache_creation_input_tokens") or 0
    if inp is None and out is None and not cache_read and not cache_write:
        return None
    return ((inp or 0) + cache_read + cache_write, out or 0, cache_read)


class SSEUsageScanner:
    """SSE 流的只读 usage 扫描器（透传用，不改写字节）。

    把逐块字节喂给 scanner（与透传并行），流结束后读取 input_tokens /
    output_tokens（均为 None 表示上游未上报）。SSEBuffer 内部自带缓冲，
    跨 chunk 分片的事件也能被正确解析，且不影响透传的原始字节。
    """

    def __init__(self, proto: str = "openai") -> None:
        self._buf = SSEBuffer()
        self.proto = proto
        self.input_tokens: Optional[int] = None
        self.output_tokens: Optional[int] = None
        self.cache_read_tokens: Optional[int] = None

    def feed(self, chunk: bytes) -> None:
        for ev_type, data_str in self._buf.feed(chunk):
            self._handle(ev_type, data_str)

    def flush(self) -> None:
        for ev_type, data_str in self._buf.flush():
            self._handle(ev_type, data_str)

    def _handle(self, ev_type, data_str: str) -> None:
        if not data_str or data_str.strip() == "[DONE]":
            return
        try:
            data = json.loads(data_str)
        except (json.JSONDecodeError, TypeError):
            return
        if not isinstance(data, dict):
            return
        if self.proto == "anthropic":
            if ev_type == "message_start":
                msg = data.get("message") or {}
                obs = anthropic_usage_of(msg)
                if obs is not None:
                    self.input_tokens, _, self.cache_read_tokens = obs
            elif ev_type == "message_delta":
                obs = anthropic_usage_of(data)
                if obs is not None:
                    self.output_tokens = obs[1]
        else:
            obs = openai_usage_of(data)
            if obs is not None:
                self.input_tokens, self.output_tokens, self.cache_read_tokens = obs


# =========================================================
#  流式转换器 A：OpenAI 上游流 → Anthropic 事件流
# =========================================================

class OpenAIStreamToAnthropic:
    """把 OpenAI 的 data: {...} / data: [DONE] 流转成 Anthropic event: 事件流。

    场景：Anthropic 客户端（Claude Code 等）→ 网关 → OpenAI 方言上游。

    Anthropic 要求同一时刻只有一个 content block 在增量增长，因此转换器在切换
    文本块 / 工具块时先 content_block_stop 上一个块，再 content_block_start 新块。
    """

    def __init__(self) -> None:
        self._buf = SSEBuffer()
        self._started = False
        self._next_block = 0                    # 下一个可分配的 anthropic content block index
        self._text_block: Optional[int] = None  # 文本块 index（未开为 None）
        self._tool_block_map: dict[int, int] = {}   # openai tool index → anthropic block index
        self._open_blocks: dict[int, str] = {}      # anthropic block index → type
        self._finish_reason: Optional[str] = None
        self.input_tokens: Optional[int] = None     # 网关观测口径：上游真实上报
        self.output_tokens: Optional[int] = None
        self.cache_read_tokens: Optional[int] = None
        self._done = False
        self._output: list[bytes] = []

    def feed(self, chunk: bytes) -> bytes:
        events = self._buf.feed(chunk)
        for ev_type, data_str in events:
            if data_str.strip() == "[DONE]":
                self._finish()
                continue
            try:
                data = json.loads(data_str)
            except (json.JSONDecodeError, TypeError):
                continue
            self._handle_openai_chunk(data)
        return self._drain()

    def _drain(self) -> bytes:
        """返回本批次新增输出，并清空累积区，保证 feed/flush 是增量消费。"""
        out = b"".join(self._output)
        self._output.clear()
        return out

    def _handle_openai_chunk(self, data: dict) -> None:
        if not self._started:
            self._output.append(self._message_start(data.get("model", "")))
            self._started = True
        choices = data.get("choices") or []
        if not choices or not isinstance(choices[0], dict):
            # 无 choices 的块通常是 usage 块（stream_options=include_usage）
            obs = openai_usage_of(data)
            if obs is not None:
                self.input_tokens, self.output_tokens, self.cache_read_tokens = obs
            return
        delta = choices[0].get("delta") or {}
        fr = choices[0].get("finish_reason")
        if fr:
            self._finish_reason = fr
        text = delta.get("content")
        if text:
            if self._text_block is None:
                self._close_blocks()
                self._text_block = self._next_block
                self._next_block += 1
                self._output.append(self._content_block_start(self._text_block, "text", None))
                self._open_blocks[self._text_block] = "text"
            self._output.append(self._content_block_delta_text(self._text_block, text))
        for tc in delta.get("tool_calls") or []:
            self._handle_tool_delta(tc)

    def _handle_tool_delta(self, tc: dict) -> None:
        t_idx = tc.get("index", 0)
        fn = tc.get("function") or {}
        block_idx = self._tool_block_map.get(t_idx)
        if block_idx is None:
            self._close_blocks()
            block_idx = self._next_block
            self._next_block += 1
            self._tool_block_map[t_idx] = block_idx
            self._output.append(self._content_block_start(block_idx, "tool_use", {
                "id": tc.get("id", ""),
                "name": (fn.get("name") or ""),
            }))
            self._open_blocks[block_idx] = "tool_use"
        args_partial = fn.get("arguments")
        if args_partial is not None:
            self._output.append(self._content_block_delta_json(block_idx, args_partial))

    def _close_blocks(self) -> None:
        for idx in sorted(self._open_blocks):
            self._output.append(self._content_block_stop(idx))
        self._open_blocks = {}

    def _finish(self) -> None:
        if self._done:
            return
        self._done = True
        if self._open_blocks:
            self._close_blocks()
        if not self._started:
            self._output.append(self._message_start(""))
            self._started = True
        delta: dict = {}
        if self._finish_reason:
            delta["stop_reason"] = _STOP_OPENAI_TO_ANTHROPIC.get(
                self._finish_reason, "end_turn"
            )
        if self.output_tokens is not None:
            delta["usage"] = {"output_tokens": self.output_tokens}
        if delta:
            self._output.append(_sse_event("message_delta", {
                "type": "message_delta",
                "delta": delta,
            }))
        self._output.append(_sse_event("message_stop", {"type": "message_stop"}))

    def flush(self) -> bytes:
        events = self._buf.flush()
        for ev_type, data_str in events:
            if data_str.strip() == "[DONE]":
                self._finish()
                continue
            try:
                data = json.loads(data_str)
            except (json.JSONDecodeError, TypeError):
                continue
            self._handle_openai_chunk(data)
        if not self._done:
            self._finish()
        return self._drain()

    def _message_start(self, model: str) -> bytes:
        msg = {
            "id": f"msg_stream_{_now_created()}",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }
        return _sse_event("message_start", {"type": "message_start", "message": msg})

    def _content_block_start(self, index: int, block_type: str, extra: Optional[dict]) -> bytes:
        blk = {"type": block_type}
        if block_type == "tool_use":
            blk.update({
                "id": (extra or {}).get("id", ""),
                "name": (extra or {}).get("name", ""),
                "input": {},
            })
        else:
            blk["text"] = ""
        return _sse_event("content_block_start", {
            "type": "content_block_start",
            "index": index,
            "content_block": blk,
        })

    def _content_block_delta_text(self, index: int, text: str) -> bytes:
        return _sse_event("content_block_delta", {
            "type": "content_block_delta",
            "index": index,
            "delta": {"type": "text_delta", "text": text},
        })

    def _content_block_delta_json(self, index: int, partial: str) -> bytes:
        return _sse_event("content_block_delta", {
            "type": "content_block_delta",
            "index": index,
            "delta": {"type": "input_json_delta", "partial_json": partial},
        })

    def _content_block_stop(self, index: int) -> bytes:
        return _sse_event("content_block_stop", {"type": "content_block_stop", "index": index})


# =========================================================
#  流式转换器 B：Anthropic 上游事件流 → OpenAI 流
# =========================================================

class AnthropicStreamToOpenAI:
    """把 Anthropic event: 事件流转成 OpenAI data: {...} 流。

    场景：OpenAI 客户端（SDK / 网关对话页 / cc-switch 本地路由）→ 网关 → Anthropic 方言上游。
    """

    def __init__(self) -> None:
        self._buf = SSEBuffer()
        self._started = False
        self._model = ""
        self._msg_id = ""
        self._created = _now_created()
        self._text_started = False
        self._tool_openai_index = 0
        self._tool_by_block: dict[int, int] = {}
        self._pending_stop: Optional[str] = None
        self.input_tokens: Optional[int] = None     # 网关观测口径：上游真实上报
        self.output_tokens: Optional[int] = None
        self.cache_read_tokens: Optional[int] = None
        self._done = False
        self._output: list[bytes] = []

    def feed(self, chunk: bytes) -> bytes:
        events = self._buf.feed(chunk)
        for ev_type, data_str in events:
            try:
                data = json.loads(data_str)
            except (json.JSONDecodeError, TypeError):
                continue
            self._handle_anthropic_event(ev_type, data)
        return self._drain()

    def _drain(self) -> bytes:
        """返回本批次新增输出，并清空累积区，保证 feed/flush 是增量消费。"""
        out = b"".join(self._output)
        self._output.clear()
        return out

    def _handle_anthropic_event(self, ev_type, data: dict) -> None:
        if not self._started:
            msg = (data.get("message") or {}) if ev_type == "message_start" else {}
            self._model = msg.get("model") or self._model
            self._msg_id = msg.get("id") or ""
            # Anthropic 流式在 message_start 的 message.usage 中给出输入（含缓存）
            obs = anthropic_usage_of(msg)
            if obs is not None:
                self.input_tokens, _, self.cache_read_tokens = obs
            self._emit({
                "id": self._msg_id,
                "object": "chat.completion.chunk",
                "created": self._created,
                "model": self._model,
                "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}],
            })
            self._started = True

        typ = (data or {}).get("type") or ev_type
        if typ == "content_block_start":
            blk = data.get("content_block") or {}
            if blk.get("type") == "text":
                self._text_started = True
            elif blk.get("type") == "tool_use":
                idx = data.get("index", 0)
                oai_idx = self._tool_openai_index
                self._tool_openai_index += 1
                self._tool_by_block[idx] = oai_idx
                self._emit({
                    "id": self._msg_id,
                    "object": "chat.completion.chunk",
                    "created": self._created,
                    "model": self._model,
                    "choices": [{
                        "index": 0,
                        "delta": {
                            "tool_calls": [{
                                "index": oai_idx,
                                "id": blk.get("id", ""),
                                "type": "function",
                                "function": {"name": blk.get("name", ""), "arguments": ""},
                            }]
                        },
                        "finish_reason": None,
                    }],
                })
        elif typ == "content_block_delta":
            delta = data.get("delta") or {}
            dtype = delta.get("type")
            idx = data.get("index", 0)
            if dtype == "text_delta":
                self._emit({
                    "id": self._msg_id,
                    "object": "chat.completion.chunk",
                    "created": self._created,
                    "model": self._model,
                    "choices": [{
                        "index": 0,
                        "delta": {"content": delta.get("text", "")},
                        "finish_reason": None,
                    }],
                })
            elif dtype == "input_json_delta":
                oai_idx = self._tool_by_block.get(idx, self._tool_openai_index - 1)
                self._emit({
                    "id": self._msg_id,
                    "object": "chat.completion.chunk",
                    "created": self._created,
                    "model": self._model,
                    "choices": [{
                        "index": 0,
                        "delta": {
                            "tool_calls": [{
                                "index": oai_idx,
                                "function": {"arguments": delta.get("partial_json", "")},
                            }]
                        },
                        "finish_reason": None,
                    }],
                })
        elif typ == "message_delta":
            d = data.get("delta") or {}
            self._pending_stop = d.get("stop_reason")
            usage = data.get("usage") or {}
            if usage.get("output_tokens") is not None:
                self.output_tokens = usage["output_tokens"]
        elif typ == "message_stop":
            self._finish()
        elif typ == "error":
            err = (data.get("error") or {})
            self._emit({
                "error": {"message": err.get("message", "upstream error"), "type": err.get("type", "error")},
                "id": self._msg_id,
                "object": "error",
            })

    def _emit(self, obj: dict) -> None:
        self._output.append(_sse_event(None, obj))

    def _finish(self) -> None:
        if self._done:
            return
        self._done = True
        if not self._started:
            self._emit({
                "id": "",
                "object": "chat.completion.chunk",
                "created": self._created,
                "model": "",
                "choices": [{"index": 0, "delta": {}, "finish_reason": None}],
            })
        chunk: dict = {
            "id": self._msg_id,
            "object": "chat.completion.chunk",
            "created": self._created,
            "model": self._model,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": _STOP_ANTHROPIC_TO_OPENAI.get(self._pending_stop or "", "stop"),
            }],
        }
        if self.output_tokens is not None:
            chunk["usage"] = {
                "prompt_tokens": 0,
                "completion_tokens": self.output_tokens,
                "total_tokens": self.output_tokens,
            }
        self._emit(chunk)
        self._output.append(b"data: [DONE]\n\n")

    def flush(self) -> bytes:
        events = self._buf.flush()
        for ev_type, data_str in events:
            try:
                data = json.loads(data_str)
            except (json.JSONDecodeError, TypeError):
                continue
            self._handle_anthropic_event(ev_type, data)
        if self._started and not self._done:
            self._finish()
        return self._drain()


# =========================================================
#  错误体转换
# =========================================================

def openai_error_to_anthropic(err: dict, status_code: int) -> dict:
    detail = err.get("detail") or {}
    if isinstance(detail, dict):
        message = detail.get("message") or detail.get("detail") or "上游错误"
    elif isinstance(detail, str):
        message = detail
    else:
        message = err.get("detail", "上游错误")
    if isinstance(message, dict):
        message = message.get("message", "上游错误")
    return {
        "type": "error",
        "error": {
            "type": "api_error" if status_code >= 500 else "invalid_request_error",
            "message": str(message),
        },
    }


def anthropic_error_to_openai(err: dict) -> dict:
    e = err.get("error") or {}
    if isinstance(e, str):
        return {"error": {"message": e, "type": "api_error"}}
    return {
        "error": {
            "message": e.get("message", "上游错误"),
            "type": e.get("type", "api_error"),
        }
    }
