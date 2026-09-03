"""反向代理路由：自动识别 OpenAI / Anthropic 两种方言并转发到对应协议上游。

能力说明：

- 入口自动识别（无需配置）：
    - `/v1/messages*` 或带 `anthropic-version` 头 → Anthropic 方言
    - `/v1/chat/completions` 等 → OpenAI 方言
- 每个上游带 protocol 标注（openai / anthropic），转发时按象限处理：
    - 同方言 → 原样透传（URL 按路径规则拼接即可）
    - 异方言 → 请求体 / 响应体 / SSE 流由 compat 层双向翻译
- 鉴权兼容两种头：`Authorization: Bearer sk-xxx` 与 `x-api-key: sk-xxx`
"""
from __future__ import annotations

import json
import math
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import compat, db
from .auth import verify_api_key

router = APIRouter(tags=["proxy"])

PROTO_OPENAI = "openai"
PROTO_ANTHROPIC = "anthropic"

# hop-by-hop / 由 httpx 或框架管理的响应头，转发时需剔除
_DROP_RESP_HEADERS = {
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
}

# 透传请求时剔除的头（鉴权按上游协议重写）
_DROP_REQ_HEADERS = {
    "authorization",
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "x-api-key",
    "anthropic-version",
}


def _upstream_error_detail(exc: BaseException) -> str:
    """把出站异常转成可读的 502 detail，带底层原因便于排查。"""
    reason = str(exc).strip()
    if reason:
        return f"上游请求失败: {exc.__class__.__name__}: {reason[:300]}"
    return f"上游请求失败: {exc.__class__.__name__}"


def _entry_dialect(path: str, request: Request) -> str:
    """识别客户端用的方言：Anthropic Messages 路径 / 版本头 → anthropic，否则 openai。"""
    if path == "messages" or path.startswith("messages/"):
        return PROTO_ANTHROPIC
    if request.headers.get("anthropic-version"):
        return PROTO_ANTHROPIC
    return PROTO_OPENAI


def _target_url(base: str, path: str, request: Request) -> str:
    query = request.url.query
    suffix = f"?{query}" if query else ""
    return f"{base}/v1/{path}{suffix}"


def _chat_url(proto: str, base: str) -> str:
    """异方言对话请求需要转发到出口协议的固定对话端点。"""
    if proto == PROTO_ANTHROPIC:
        return f"{base}/v1/messages"
    return f"{base}/v1/chat/completions"


def _build_upstream_headers(
    request: Request, upstream_api_key: str = "", protocol: str = PROTO_OPENAI
) -> dict[str, str]:
    headers: dict[str, str] = {}
    for key, value in request.headers.items():
        if key.lower() in _DROP_REQ_HEADERS:
            continue
        headers[key] = value
    if upstream_api_key:
        if protocol == PROTO_ANTHROPIC:
            headers["x-api-key"] = upstream_api_key
            headers["anthropic-version"] = compat._ANTHROPIC_VERSION
        else:
            headers["Authorization"] = f"Bearer {upstream_api_key}"
    return headers


async def _commit_usage(usage_log_id, input_tokens, output_tokens, cache_read_tokens=None) -> None:
    """尽力回填 token 用量；上游未上报（两项均 None）时不落库覆盖。"""
    if not usage_log_id:
        return
    if input_tokens is None and output_tokens is None:
        return
    try:
        await db.update_usage_log(
            usage_log_id, input_tokens, output_tokens, cache_read_tokens
        )
    except Exception:
        # 统计回填失败不应影响已返回的流/响应
        pass


def _maybe_inject_include_usage(
    body: Optional[bytes], upstream: dict, exit_proto: str
) -> Optional[bytes]:
    """同方言 OpenAI 流式透传时，按上游开关自动补 stream_options.include_usage。

    Ollama / vLLM 等 OpenAI 兼容上游严格遵守 OpenAI 协议：流式请求若不带
    stream_options.include_usage，流末尾就不会上报 usage 块，网关旁路扫描
    记不到 token。此函数在转发前对请求体做一次只读解析注入：

    - 仅当出口为 openai 方言、上游开了 inject_include_usage 开关、
      请求体是含 stream=true 的 JSON、且未显式声明 include_usage 时才改写；
    - 客户端已自带 include_usage 或请求体不是可解析 JSON 时原样返回（不破坏字节）。
    """
    if exit_proto != PROTO_OPENAI or not upstream.get("inject_include_usage"):
        return body
    if not body:
        return body
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, TypeError):
        return body
    if not isinstance(data, dict) or not data.get("stream"):
        return body
    so = data.get("stream_options")
    if isinstance(so, dict) and so.get("include_usage"):
        return body
    data["stream_options"] = {"include_usage": True}
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


async def _relay_upstream(
    method: str,
    url: str,
    headers: dict[str, str],
    body: Optional[bytes],
    *,
    proto: str = PROTO_OPENAI,
    usage_log_id: Optional[int] = None,
) -> Response:
    """原样转发上游响应（同协议透传），并按上游协议旁路采集 usage。

    - SSE 流：逐块透传的同时喂 SSEUsageScanner（不改写字节），
      流结束后把观测到的 token 回填到 usage_logs；
    - 其余（JSON 等）：整读响应后透传，成功且带 usage 的 JSON 一并采集；
    - 注意：不能用 async with client.stream(...) 后返回 StreamingResponse，
      否则上下文会在响应体被消费前关闭上游连接，导致空响应。
      这里手动管理 client / response 的生命周期，在生成器结束时关闭。
      trust_env=False：不读环境代理/证书变量。实测 pyenv 3.10 下
      trust_env=True 会让全部 HTTPS 出站 ConnectError（本机复现），直连反而正常。
    """
    client = httpx.AsyncClient(timeout=None, trust_env=False)
    req = client.build_request(method, url, headers=headers, content=body)
    upstream = await client.send(req, stream=True)
    status_code = upstream.status_code
    ctype = upstream.headers.get("content-type", "")
    resp_headers = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() not in _DROP_RESP_HEADERS
    }
    collect = usage_log_id and status_code < 400

    if "text/event-stream" in ctype:
        scanner = compat.SSEUsageScanner(proto) if collect else None

        async def body_iter():
            try:
                async for chunk in upstream.aiter_raw():
                    if scanner is not None:
                        scanner.feed(chunk)
                    yield chunk
            finally:
                if scanner is not None:
                    scanner.flush()
                    await _commit_usage(
                        usage_log_id,
                        scanner.input_tokens,
                        scanner.output_tokens,
                        scanner.cache_read_tokens,
                    )
                await upstream.aclose()
                await client.aclose()

        return StreamingResponse(
            body_iter(),
            status_code=status_code,
            headers=resp_headers,
        )

    # 非流式：整读后透传，若为 JSON 且带 usage 则采集
    raw = await upstream.aread()
    await upstream.aclose()
    await client.aclose()

    if collect and "json" in ctype:
        try:
            data = json.loads(raw.decode("utf-8", errors="replace"))
            if isinstance(data, dict):
                if proto == PROTO_ANTHROPIC:
                    obs = compat.anthropic_usage_of(data)
                else:
                    obs = compat.openai_usage_of(data)
                if obs is not None:
                    await _commit_usage(usage_log_id, obs[0], obs[1], obs[2])
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass

    return Response(content=raw, status_code=status_code, headers=resp_headers)


def _translate_request_body(body: dict, from_proto: str, to_proto: str) -> str:
    """请求体方言翻译（异方言时调用）。"""
    if from_proto == PROTO_ANTHROPIC and to_proto == PROTO_OPENAI:
        return json.dumps(compat.anthropic_to_openai_req(body), ensure_ascii=False)
    if from_proto == PROTO_OPENAI and to_proto == PROTO_ANTHROPIC:
        return json.dumps(compat.openai_to_anthropic_req(body), ensure_ascii=False)
    return json.dumps(body, ensure_ascii=False)


async def _forward_translated(
    method: str,
    url: str,
    headers: dict[str, str],
    body: Optional[bytes],
    exit_proto: str,
    entry_proto: str,
    usage_log_id: Optional[int] = None,
) -> Response:
    """把（已翻译成 exit_proto 的）请求发给上游，再把上游响应翻译回 entry_proto。

    支持 SSE 流式事件与 JSON 整体响应两类；非 2xx 错误体也会做形状转换。
    流式转换器在解析事件时已捕获上游真实 usage，结束后回填 usage_logs。
    """
    client = httpx.AsyncClient(timeout=None, trust_env=False)
    req = client.build_request(method, url, headers=headers, content=body)
    upstream = await client.send(req, stream=True)
    status_code = upstream.status_code
    ctype = upstream.headers.get("content-type", "")
    resp_headers = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() not in _DROP_RESP_HEADERS
    }

    is_sse = "text/event-stream" in ctype

    # ---- 流式：按事件逐块翻译 ----
    if is_sse and status_code == 200:
        if exit_proto == PROTO_OPENAI and entry_proto == PROTO_ANTHROPIC:
            transformer = compat.OpenAIStreamToAnthropic()
        elif exit_proto == PROTO_ANTHROPIC and entry_proto == PROTO_OPENAI:
            transformer = compat.AnthropicStreamToOpenAI()
        else:
            transformer = None

        async def translated_iter():
            try:
                if transformer is not None:
                    async for chunk in upstream.aiter_raw():
                        out = transformer.feed(chunk)
                        if out:
                            yield out
                    tail = transformer.flush()
                    if tail:
                        yield tail
                else:
                    async for chunk in upstream.aiter_raw():
                        yield chunk
            finally:
                if transformer is not None:
                    await _commit_usage(
                        usage_log_id,
                        getattr(transformer, "input_tokens", None),
                        getattr(transformer, "output_tokens", None),
                        getattr(transformer, "cache_read_tokens", None),
                    )
                await upstream.aclose()
                await client.aclose()

        resp_headers["content-type"] = "text/event-stream; charset=utf-8"
        return StreamingResponse(translated_iter(), status_code=200, headers=resp_headers)

    # ---- 非流式：整体读取后翻译 ----
    raw = await upstream.aread()
    await upstream.aclose()
    await client.aclose()

    # 同协议兜底（理论上不会走到，防御）
    if exit_proto == entry_proto:
        return Response(content=raw, status_code=status_code, headers=resp_headers)

    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        data = None

    # 非 2xx：尝试转错误体形状
    if status_code >= 400:
        if data is None:
            out = compat.openai_error_to_anthropic({"detail": raw.decode(errors="replace")}, status_code) \
                if entry_proto == PROTO_ANTHROPIC else \
                {"error": {"message": raw.decode(errors="replace"), "type": "api_error"}}
            return JSONResponse(content=out, status_code=status_code)
        if entry_proto == PROTO_ANTHROPIC and exit_proto == PROTO_OPENAI:
            out = compat.openai_error_to_anthropic(data, status_code)
        elif entry_proto == PROTO_OPENAI and exit_proto == PROTO_ANTHROPIC:
            out = compat.anthropic_error_to_openai(data)
        else:
            out = data
        return JSONResponse(content=out, status_code=status_code)

    # 正常响应：先按上游协议提取真实 usage，再做方言翻译
    if isinstance(data, dict):
        if usage_log_id:
            if exit_proto == PROTO_ANTHROPIC:
                obs = compat.anthropic_usage_of(data)
            else:
                obs = compat.openai_usage_of(data)
            if obs is not None:
                await _commit_usage(usage_log_id, obs[0], obs[1], obs[2])
        if entry_proto == PROTO_ANTHROPIC and exit_proto == PROTO_OPENAI:
            # 客户端 Anthropic、上游 OpenAI：OpenAI 响应 → Anthropic
            out = compat.openai_to_anthropic_resp(data)
        elif entry_proto == PROTO_OPENAI and exit_proto == PROTO_ANTHROPIC:
            # 客户端 OpenAI、上游 Anthropic：Anthropic 响应 → OpenAI
            out = compat.anthropic_to_openai_resp(data)
        else:
            out = data
        return JSONResponse(content=out, status_code=status_code)
    return Response(content=raw, status_code=status_code, headers=resp_headers)


async def _handle_count_tokens(body_bytes: Optional[bytes], base_url: str, upstream_api_key: str) -> Response:
    """入口是 Anthropic /v1/messages/count_tokens，出口是 OpenAI 上游时本地估算。

    仅用于 Claude Code 等客户端的上文预算检查，估算精度不参与生成。
    """
    n = 0
    if body_bytes:
        try:
            data = json.loads(body_bytes)
            n = len(json.dumps(data.get("messages") or [], ensure_ascii=False))
        except (json.JSONDecodeError, TypeError):
            n = 0
    input_tokens = max(1, math.ceil(n / 4))
    return JSONResponse(content={"input_tokens": input_tokens})


@router.get("/health")
async def health() -> dict:
    """健康检查：探测默认上游可连接性，不可达时返回 502。"""
    default = await db.get_default_upstream()
    if not default:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="未配置默认上游",
        )
    base = default["base_url"]
    proto = default.get("protocol", PROTO_OPENAI)
    probe = f"{base}/health" if proto == PROTO_OPENAI else base
    try:
        async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
            r = await client.get(probe)
        return {"status": "ok", "upstream_status": r.status_code, "upstream": default["name"]}
    except httpx.HTTPError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="上游服务不可达",
        )


@router.api_route(
    "/v1/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
)
async def proxy(path: str, request: Request, key_record: dict = Depends(verify_api_key)) -> Response:
    upstream = await db.get_upstream_for_key(key_record["id"])
    if not upstream:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="未找到可用的上游配置",
        )
    base = upstream["base_url"]
    exit_proto = upstream.get("protocol", PROTO_OPENAI)
    if exit_proto not in (PROTO_OPENAI, PROTO_ANTHROPIC):
        exit_proto = PROTO_OPENAI
    entry_proto = _entry_dialect(path, request)
    same_proto = entry_proto == exit_proto
    usage_log_id = key_record.get("_usage_log_id")

    # Anthropic 客户端的 token 计数请求：若上游也是 anthropic 则透传，否则本地估算
    if path == "messages/count_tokens":
        if exit_proto == PROTO_ANTHROPIC:
            url = _target_url(base, path, request)
            headers = _build_upstream_headers(request, upstream.get("api_key", ""), exit_proto)
            body = await request.body()
            try:
                return await _relay_upstream(request.method, url, headers, body or None, proto=exit_proto)
            except httpx.HTTPError as exc:
                raise HTTPException(status_code=502, detail=_upstream_error_detail(exc))
        return await _handle_count_tokens(await request.body(), base, upstream.get("api_key", ""))

    # 对话类请求（OpenAI chat/completions ↔ Anthropic messages）
    is_chat = (path == "chat/completions") or (path == "messages")
    if is_chat:
        body_bytes = await request.body()
        headers = _build_upstream_headers(request, upstream.get("api_key", ""), exit_proto)

        if same_proto:
            # 同方言：URL 直接按路径拼，原样透传（旁路采集 usage）
            url = _target_url(base, path, request)
            forwarded_body = _maybe_inject_include_usage(body_bytes or None, upstream, exit_proto)
            try:
                return await _relay_upstream(
                    request.method, url, headers, forwarded_body,
                    proto=exit_proto, usage_log_id=usage_log_id,
                )
            except httpx.HTTPError as exc:
                raise HTTPException(status_code=502, detail=_upstream_error_detail(exc))

        # 异方言：请求体翻译 + URL 固定到出口协议的对话端点 + 响应反向翻译
        try:
            body_json = json.loads(body_bytes) if body_bytes else {}
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
        if not isinstance(body_json, dict):
            raise HTTPException(status_code=400, detail="请求体应为 JSON 对象")
        translated_body = _translate_request_body(body_json, entry_proto, exit_proto).encode("utf-8")
        url = _chat_url(exit_proto, base)
        try:
            return await _forward_translated(
                request.method, url, headers, translated_body, exit_proto, entry_proto,
                usage_log_id=usage_log_id,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=_upstream_error_detail(exc))

    # 其余 /v1/*（models、embeddings、completions 等）：按 OpenAI 路径透传
    url = _target_url(base, path, request)
    headers = _build_upstream_headers(request, upstream.get("api_key", ""), exit_proto)
    body = await request.body()
    try:
        return await _relay_upstream(
            request.method, url, headers, body or None,
            proto=exit_proto, usage_log_id=usage_log_id,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=_upstream_error_detail(exc),
        )
