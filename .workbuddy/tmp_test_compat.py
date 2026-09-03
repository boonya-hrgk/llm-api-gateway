"""compat.py 单元测试：协议转换与流式转换器。"""
import json
import sys

sys.path.insert(0, r"E:\AI\python\llm-proxy-tk\proxy")
from app import compat

passed = 0


def ok(name, cond):
    global passed
    assert cond, f"FAIL: {name}"
    passed += 1
    print(f"  ok - {name}")


# ---- 1. anthropic -> openai 请求（system + 文本 + tools + tool_use/tool_result）----
req = {
    "model": "qwen3:8b-nothink",
    "system": "你是一个助手",
    "max_tokens": 512,
    "tools": [{"name": "list_files", "description": "列出目录", "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}],
    "messages": [
        {"role": "user", "content": "列出文件"},
        {"role": "assistant", "content": [{"type": "text", "text": "好的"}, {"type": "tool_use", "id": "toolu_1", "name": "list_files", "input": {"path": "."}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "a.txt"}]},
        {"role": "user", "content": "继续"},
    ],
}
o = compat.anthropic_to_openai_req(req)
ok("A2O: system 前置", o["messages"][0] == {"role": "system", "content": "你是一个助手"})
ok("A2O: assistant 文本+tool_calls", o["messages"][2]["content"] == "好的" and o["messages"][2]["tool_calls"][0]["function"]["name"] == "list_files")
ok("A2O: tool_result → role=tool", o["messages"][3]["role"] == "tool" and o["messages"][3]["tool_call_id"] == "toolu_1")
ok("A2O: 工具 schema", o["tools"][0]["function"]["name"] == "list_files")

# ---- 2. openai -> anthropic 请求 ----
req2 = {
    "model": "m",
    "messages": [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"/x"}'}}]},
        {"role": "tool", "tool_call_id": "call_1", "content": "content of x"},
    ],
    "tools": [{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}],
    "tool_choice": {"type": "function", "function": {"name": "read_file"}},
}
a = compat.openai_to_anthropic_req(req2)
ok("O2A: max_tokens 兜底", a.get("max_tokens") == compat.DEFAULT_MAX_TOKENS)
ok("O2A: system 提取", a["system"] == "sys")
ok("O2A: tool_use 块", a["messages"][1]["content"][0]["type"] == "tool_use" and a["messages"][1]["content"][0]["name"] == "read_file")
ok("O2A: tool 消息转 tool_result", a["messages"][2]["role"] == "user" and a["messages"][2]["content"][0]["type"] == "tool_result")
ok("O2A: tool_choice 映射", a["tool_choice"] == {"type": "tool", "name": "read_file"})

# ---- 3. anthropic -> openai 非流式响应 ----
aresp = {
    "id": "msg_1", "type": "message", "role": "assistant", "model": "m",
    "content": [{"type": "text", "text": "结果"}, {"type": "tool_use", "id": "tu2", "name": "write_file", "input": {"p": "/a", "c": "x"}}],
    "stop_reason": "tool_use", "usage": {"input_tokens": 10, "output_tokens": 5},
}
oresp = compat.anthropic_to_openai_resp(aresp)
ok("A2O 响应: 文本拼接", oresp["choices"][0]["message"]["content"] == "结果")
ok("A2O 响应: tool_calls", oresp["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] == '{"p": "/a", "c": "x"}')
ok("A2O 响应: finish_reason", oresp["choices"][0]["finish_reason"] == "tool_calls")
ok("A2O 响应: usage", oresp["usage"]["prompt_tokens"] == 10)

# ---- 4. openai -> anthropic 非流式响应 ----
oresp2 = {
    "id": "chatcmpl-1", "object": "chat.completion", "created": 0, "model": "m",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi", "tool_calls": [{"id": "c2", "type": "function", "function": {"name": "f2", "arguments": '{"a":1}'}}]}, "finish_reason": "tool_calls"}],
    "usage": {"prompt_tokens": 8, "completion_tokens": 6, "total_tokens": 14},
}
aresp2 = compat.openai_to_anthropic_resp(oresp2)
ok("O2A 响应: text block", aresp2["content"][0] == {"type": "text", "text": "hi"})
ok("O2A 响应: tool_use", aresp2["content"][1]["type"] == "tool_use" and aresp2["content"][1]["input"] == {"a": 1})
ok("O2A 响应: stop_reason", aresp2["stop_reason"] == "tool_use")

# ---- 5. SSE 缓冲器：跨 chunk 分片 ----
buf = compat.SSEBuffer()
evs = buf.feed(b'data: {"a":1}\n\ndata: {"b')
ok("SSE 半片不输出", len(evs) == 1 and evs[0][1] == '{"a":1}')
evs = buf.feed(b'":2}\n\n')
ok("SSE 续片", len(evs) == 1 and json.loads(evs[0][1]) == {"b": 2})

# ---- 6. OpenAI 流 → Anthropic 事件流（含文本与工具）----
t = compat.OpenAIStreamToAnthropic()
sse = (
    'data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n'
    'data: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n'
    'data: {"choices":[{"index":0,"delta":{"content":"，世界"},"finish_reason":null}]}\n\n'
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"ls","arguments":""}}]},"finish_reason":null}]}\n\n'
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n'
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\".\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
    'data: {"usage":{"prompt_tokens":3,"completion_tokens":9}}\n\n'
    "data: [DONE]\n\n"
)
out = t.feed(sse.encode()) + t.flush()
text = out.decode()
ok("A流: message_start", "event: message_start" in text and '"role": "assistant"' in text)
ok("A流: text 增量", '"type": "text_delta"' in text and '"你好"' in text and '"，世界"' in text)
ok("A流: tool_use start", '"name": "ls"' in text and '"type": "tool_use"' in text)
ok("A流: input_json_delta", '"type": "input_json_delta"' in text)
ok("A流: message_delta stop=tool_use", '"stop_reason": "tool_use"' in text)
ok("A流: message_stop", "event: message_stop" in text)
# content_block index 顺序与 stop 配对
starts = [l for l in text.splitlines() if "content_block_start" in l]
ok("A流: 至少 text+tool 两个块", len(starts) == 2)

# ---- 7. Anthropic 事件流 → OpenAI 流 ----
t2 = compat.AnthropicStreamToOpenAI()
msg = {
    "id": "msg_x", "type": "message", "role": "assistant", "model": "claude",
    "content": [], "stop_reason": None, "usage": {"input_tokens": 5, "output_tokens": 0},
}
sse2 = (
    'event: message_start\ndata: {"type":"message_start","message":' + json.dumps(msg) + '}\n\n'
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n'
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu","name":"f","input":{}}}\n\n'
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}\n\n'
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}\n\n'
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
)
out2 = t2.feed(sse2.encode()).decode()
ok("O流: role chunk", '"role": "assistant"' in out2)
ok("O流: 文本 delta", '"content": "hello"' in out2)
ok("O流: tool 增量带 name", '"name": "f"' in out2)
ok("O流: 工具 args 增量", '"arguments": "{\\"x\\":1}"' in out2)
ok("O流: finish tool_calls", '"finish_reason": "tool_calls"' in out2)
ok("O流: usage", '"completion_tokens": 8' in out2)
ok("O流: [DONE]", "data: [DONE]" in out2)

print(f"\nALL {passed} PASSED")
