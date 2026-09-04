"""管理路由：登录 + API-key 的发放 / 列表 / 查询 / 吊销 + 用户管理 + 统计 + 上游管理。

权限模型（收紧普通用户 viewer）：
- role=admin（管理员）：全部能力；密钥 / 统计 / 上游默认返回全量数据。
- role=viewer（普通用户）：
    * 只能访问「用量统计」「对话测试」所需接口；
    * 只能看到 / 回显 / 测试自己名下（owner_id = 本人）的密钥；
    * 用量统计只按自己名下密钥过滤；
    * 上游只返回其名下密钥可达的上游，且裁剪掉 base_url / api_key；
    * owner_id 为 NULL 的密钥 = 系统密钥，仅管理员可见。
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from . import db
from .auth import create_admin_jwt, require_admin, verify_admin_jwt
from .schemas import (
    KeyCreateRequest,
    KeyListItem,
    KeyOwnerRequest,
    KeyRenameRequest,
    LoginRequest,
    LoginResponse,
    Message,
    OverallStats,
    UpstreamCreateRequest,
    UpstreamItem,
    UpstreamUpdateRequest,
    UsageMatrix,
    UsageStats,
    UserCreateRequest,
    UserInfo,
    UserListItem,
    UserUpdateRequest,
)

router = APIRouter(prefix="/admin", tags=["admin"])

_admin_router = APIRouter(dependencies=[Depends(require_admin)])

_GRANULARITIES = ("day", "week", "month")


def _granularity(value: str) -> str:
    if value not in _GRANULARITIES:
        raise HTTPException(
            status_code=400,
            detail=f"granularity 只支持 {'/'.join(_GRANULARITIES)}",
        )
    return value


def _viewer_owner_id(user: dict) -> Optional[int]:
    """admin → None（全量）；viewer → 本人 user id（仅自己的密钥）。"""
    return None if user.get("role") == "admin" else user["id"]


async def _ensure_key_visible(key_id: int, user: dict) -> dict:
    """取单条密钥（不含明文）；viewer 访问非自己名下密钥视为不存在（404）。"""
    record = await db.get_key(key_id)
    if record is None:
        raise HTTPException(status_code=404, detail="密钥不存在")
    if user.get("role") != "admin" and record.get("owner_id") != user["id"]:
        raise HTTPException(status_code=404, detail="密钥不存在")
    return record


async def _ensure_key_revealable(key_id: int, user: dict) -> dict:
    """取含明文密钥记录用于回显；viewer 仅能回显自己名下密钥。"""
    record = await db.get_key_full(key_id)
    if record is None:
        raise HTTPException(status_code=404, detail="密钥不存在")
    if user.get("role") != "admin" and record.get("owner_id") != user["id"]:
        raise HTTPException(status_code=403, detail="权限不足，仅能操作自己的密钥")
    return record


def _sanitize_upstream_for_viewer(up: dict) -> dict:
    """对话页模型候选只需 id/name/protocol/models/is_default；对普通用户裁剪地址与上游 key。"""
    d = dict(up)
    d["base_url"] = ""
    d["api_key"] = ""
    return d


@router.post("/login", response_model=LoginResponse)
async def admin_login(body: LoginRequest) -> dict:
    user = await db.get_admin_by_username(body.username)
    if not user:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not db.verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    role = user.get("role", "viewer")
    token, expires_in = create_admin_jwt(user["id"], user["username"], role)
    await db.update_admin_last_login(user["id"])
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": expires_in,
        "user": {"id": user["id"], "username": user["username"], "role": role},
    }


@router.get("/me", response_model=UserInfo)
async def get_me(current_user: dict = Depends(verify_admin_jwt)) -> dict:
    return current_user


# ============ 密钥：普通用户仅自己名下；管理员全量 ============

@router.get("/keys", response_model=list[KeyListItem])
async def list_keys(current_user: dict = Depends(verify_admin_jwt)) -> list[dict]:
    return await db.list_keys(owner_id=_viewer_owner_id(current_user))


@router.get("/keys/{key_id}", response_model=KeyListItem)
async def get_key(
    key_id: int, current_user: dict = Depends(verify_admin_jwt)
) -> dict:
    return await _ensure_key_visible(key_id, current_user)


@router.get("/keys/{key_id}/reveal")
async def reveal_key(
    key_id: int, current_user: dict = Depends(verify_admin_jwt)
) -> dict:
    """回显明文：管理员任意密钥；普通用户仅自己名下密钥。"""
    record = await _ensure_key_revealable(key_id, current_user)
    if not record.get("key"):
        raise HTTPException(
            status_code=410,
            detail="该密钥创建于明文回显功能上线之前，无明文可回显；可新建/重置密钥以获取完整 sk",
        )
    return {"id": record["id"], "key": record["key"]}


@_admin_router.post("/keys")
async def create_key(body: KeyCreateRequest) -> JSONResponse:
    if body.upstream_id is not None:
        up = await db.get_upstream(body.upstream_id)
        if not up:
            raise HTTPException(status_code=400, detail="上游不存在")
    if body.owner_id is not None:
        owner = await db.get_admin_by_id(body.owner_id)
        if not owner or owner["role"] != "viewer":
            raise HTTPException(status_code=400, detail="归属用户不存在或不是普通用户")
    record = await db.create_key(
        body.name, body.expires_at, body.upstream_id, owner_id=body.owner_id
    )
    return JSONResponse(content=record)


@_admin_router.patch("/keys/{key_id}", response_model=KeyListItem)
async def rename_key(key_id: int, body: KeyRenameRequest) -> dict:
    """仅修改密钥备注名称。用量统计按 key 聚合，改名后历史记录一并显示新名称。"""
    name = (body.name or "").strip() or None
    ok = await db.rename_key(key_id, name)
    if not ok:
        raise HTTPException(status_code=404, detail="密钥不存在")
    updated = await db.get_key(key_id)
    if not updated:
        raise HTTPException(status_code=500, detail="更新失败")
    return updated


@_admin_router.patch("/keys/{key_id}/owner", response_model=KeyListItem)
async def update_key_owner(key_id: int, body: KeyOwnerRequest) -> dict:
    """转移 / 解除密钥归属：归属给某普通用户，或解除为系统密钥（仅管理员可见）。"""
    if body.owner_id is not None:
        owner = await db.get_admin_by_id(body.owner_id)
        if not owner or owner["role"] != "viewer":
            raise HTTPException(status_code=400, detail="归属用户不存在或不是普通用户")
    ok = await db.set_key_owner(key_id, body.owner_id)
    if not ok:
        raise HTTPException(status_code=404, detail="密钥不存在")
    updated = await db.get_key(key_id)
    if not updated:
        raise HTTPException(status_code=500, detail="更新失败")
    return updated


@_admin_router.delete("/keys/{key_id}", response_model=Message)
async def revoke_key(key_id: int) -> dict:
    ok = await db.revoke_key(key_id)
    if not ok:
        raise HTTPException(status_code=404, detail="密钥不存在或已吊销")
    return {"message": "已吊销"}


@_admin_router.post("/keys/{key_id}/reset")
async def reset_key(key_id: int) -> dict:
    """重置密钥：新明文替换旧值并回显一次，旧 key 立即失效。"""
    record = await db.reset_key(key_id)
    if not record:
        raise HTTPException(status_code=404, detail="密钥不存在或已吊销")
    return record


# ============ 用量统计：普通用户仅自己名下密钥；管理员全量 ============

@_admin_router.get("/stats/overview", response_model=OverallStats)
async def stats_overview() -> dict:
    """系统级汇总（含全站密钥/用户数），仅管理员可见。"""
    return await db.get_overall_stats()


@router.get("/stats/usage", response_model=UsageStats)
async def stats_usage(
    days: int = Query(default=7, ge=1, le=365),
    top: int = Query(default=10, ge=1, le=100),
    granularity: str = Query(default="day", description="day / week / month"),
    current_user: dict = Depends(verify_admin_jwt),
) -> dict:
    gran = _granularity(granularity)
    owner_id = _viewer_owner_id(current_user)
    trend = await db.get_usage_trend(days=days, granularity=gran, owner_id=owner_id)
    by_key = await db.get_usage_by_key(
        days=days, granularity=gran, limit=top, owner_id=owner_id
    )
    return {"trend": trend, "by_key": by_key}


@router.get("/stats/usage/matrix", response_model=UsageMatrix)
async def stats_usage_matrix(
    days: int = Query(default=7, ge=1, le=365),
    granularity: str = Query(default="day", description="day / week / month"),
    current_user: dict = Depends(verify_admin_jwt),
) -> dict:
    """密钥 × 周期（每日/每周/每月）的用量明细矩阵。"""
    gran = _granularity(granularity)
    return await db.get_usage_matrix(
        days=days, granularity=gran, owner_id=_viewer_owner_id(current_user)
    )


# ============ 用户管理：仅管理员 ============

@_admin_router.get("/users", response_model=list[UserListItem])
async def list_users() -> list[dict]:
    return await db.list_admin_users()


@_admin_router.post("/users", response_model=UserListItem)
async def create_user(body: UserCreateRequest) -> dict:
    if body.role not in ("admin", "viewer"):
        raise HTTPException(status_code=400, detail="角色只能是 admin 或 viewer")
    existing = await db.get_admin_by_username(body.username)
    if existing:
        raise HTTPException(status_code=400, detail="用户名已存在")
    user_id = await db.create_admin_user(body.username, body.password, body.role)
    user = await db.get_admin_by_id(user_id)
    if not user:
        raise HTTPException(status_code=500, detail="创建失败")
    return user


@_admin_router.patch("/users/{user_id}", response_model=UserListItem)
async def update_user(user_id: int, body: UserUpdateRequest, current_user: dict = Depends(require_admin)) -> dict:
    user = await db.get_admin_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if body.role is not None:
        if body.role not in ("admin", "viewer"):
            raise HTTPException(status_code=400, detail="角色只能是 admin 或 viewer")
        if user_id == current_user["id"] and body.role != "admin":
            raise HTTPException(status_code=400, detail="不能修改自己的管理员角色")
        await db.update_admin_role(user_id, body.role)
    if body.password is not None:
        if len(body.password) < 1:
            raise HTTPException(status_code=400, detail="密码不能为空")
        await db.update_admin_password(user_id, body.password)
    updated = await db.get_admin_by_id(user_id)
    if not updated:
        raise HTTPException(status_code=500, detail="更新失败")
    return updated


@_admin_router.delete("/users/{user_id}", response_model=Message)
async def delete_user(user_id: int, current_user: dict = Depends(require_admin)) -> dict:
    if user_id == current_user["id"]:
        raise HTTPException(status_code=400, detail="不能删除自己")
    ok = await db.delete_admin_user(user_id)
    if not ok:
        raise HTTPException(status_code=404, detail="用户不存在")
    return {"message": "已删除"}


# ============ 上游：管理仅管理员；普通用户只能读到其密钥可达上游的裁剪信息（供对话模型候选） ============

@router.get("/upstreams", response_model=list[UpstreamItem])
async def list_upstreams(current_user: dict = Depends(verify_admin_jwt)) -> list[dict]:
    if current_user.get("role") == "admin":
        return await db.list_upstreams()
    return [
        _sanitize_upstream_for_viewer(up)
        for up in await db.list_upstreams_for_user(current_user["id"])
    ]


@router.get("/upstreams/{upstream_id}", response_model=UpstreamItem)
async def get_upstream(
    upstream_id: int, current_user: dict = Depends(verify_admin_jwt)
) -> dict:
    if current_user.get("role") == "admin":
        up = await db.get_upstream(upstream_id)
    else:
        allowed = await db.list_upstreams_for_user(current_user["id"])
        up = next((u for u in allowed if u["id"] == upstream_id), None)
        if up is not None:
            up = _sanitize_upstream_for_viewer(up)
    if not up:
        raise HTTPException(status_code=404, detail="上游不存在")
    return up


@_admin_router.post("/upstreams", response_model=UpstreamItem)
async def create_upstream(body: UpstreamCreateRequest) -> dict:
    return await db.create_upstream(
        body.name, body.base_url, body.api_key, body.protocol, body.is_default,
        models=body.models, inject_include_usage=body.inject_include_usage,
    )


@_admin_router.put("/upstreams/{upstream_id}", response_model=UpstreamItem)
async def update_upstream(upstream_id: int, body: UpstreamUpdateRequest) -> dict:
    ok = await db.update_upstream(
        upstream_id, body.name, body.base_url, body.api_key, body.protocol, body.is_default,
        models=body.models, inject_include_usage=body.inject_include_usage,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="上游不存在")
    up = await db.get_upstream(upstream_id)
    if not up:
        raise HTTPException(status_code=500, detail="更新失败")
    return up


@_admin_router.delete("/upstreams/{upstream_id}", response_model=Message)
async def delete_upstream(upstream_id: int) -> dict:
    ok = await db.delete_upstream(upstream_id)
    if not ok:
        raise HTTPException(status_code=400, detail="删除失败（默认上游不能删除）")
    return {"message": "已删除"}


@_admin_router.patch("/keys/{key_id}/upstream", response_model=Message)
async def update_key_upstream(key_id: int, body: dict) -> dict:
    upstream_id = body.get("upstream_id")
    if upstream_id is not None:
        up = await db.get_upstream(upstream_id)
        if not up:
            raise HTTPException(status_code=400, detail="上游不存在")
    ok = await db.update_key_upstream(key_id, upstream_id)
    if not ok:
        raise HTTPException(status_code=404, detail="密钥不存在")
    return {"message": "已更新"}


router.include_router(_admin_router)
