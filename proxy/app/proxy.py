"""反向代理路由：把 /v1/* 透传到上游大模型服务，支持流式 SSE。

所有 /v1/* 请求必须通过 verify_api_key 鉴权，按 key 绑定的上游转发。
"""
from __future__ import annotations

from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from . import db
from .auth import verify_api_key
from .config import settings

router = APIRouter(tags=["proxy"])

# hop-by-hop / 由 httpx 或框架管理的响应头，转发时需剔除
_DROP_RESP_HEADERS = {
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
}

# 透传请求时剔除的头（Authorization 由我们按上游配置重写）
_DROP_REQ_HEADERS = {
    "authorization",
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
}


def _target_url(base: str, path: str, request: Request) -> str:
    query = request.url.query
    suffix = f"?{query}" if query else ""
    return f"{base}/v1/{path}{suffix}"


def _build_upstream_headers(request: Request, upstream_api_key: str = "") -> dict[str, str]:
    headers: dict[str, str] = {}
    for key, value in request.headers.items():
        if key.lower() in _DROP_REQ_HEADERS:
            continue
        headers[key] = value
    if upstream_api_key:
        headers["Authorization"] = f"Bearer {upstream_api_key}"
    return headers


async def _stream_upstream(
    method: str,
    url: str,
    headers: dict[str, str],
    body: Optional[bytes],
):
    # 注意：不能用 async with client.stream(...) 然后返回 StreamingResponse，
    # 否则上下文会在响应体被消费前关闭上游连接，导致空响应。
    # 这里手动管理 client / response 的生命周期，在生成器结束时关闭。
    client = httpx.AsyncClient(timeout=None)
    req = client.build_request(method, url, headers=headers, content=body)
    upstream = await client.send(req, stream=True)
    resp_headers = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() not in _DROP_RESP_HEADERS
    }

    async def body_iter():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        body_iter(),
        status_code=upstream.status_code,
        headers=resp_headers,
    )


@router.get("/health")
async def health() -> dict:
    """健康检查：探测默认上游 /health，不可达时返回 502。"""
    default = await db.get_default_upstream()
    if not default:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="未配置默认上游",
        )
    url = f"{default['base_url']}/health"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(url)
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
async def proxy(path: str, request: Request, key_record: dict = Depends(verify_api_key)) -> StreamingResponse:
    upstream = await db.get_upstream_for_key(key_record["id"])
    if not upstream:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="未找到可用的上游配置",
        )
    url = _target_url(upstream["base_url"], path, request)
    headers = _build_upstream_headers(request, upstream.get("api_key", ""))
    body = await request.body()
    if not body:
        body = None
    try:
        return await _stream_upstream(request.method, url, headers, body)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"上游请求失败: {exc.__class__.__name__}",
        )
