"""管理路由：登录 + API-key 的发放 / 列表 / 查询 / 吊销 + 用户管理 + 统计 + 上游管理。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from . import db
from .auth import create_admin_jwt, require_admin, verify_admin_jwt
from .schemas import (
    KeyCreateRequest,
    KeyListItem,
    LoginRequest,
    LoginResponse,
    Message,
    OverallStats,
    UpstreamCreateRequest,
    UpstreamItem,
    UpstreamUpdateRequest,
    UsageStats,
    UserCreateRequest,
    UserInfo,
    UserListItem,
    UserUpdateRequest,
)

router = APIRouter(prefix="/admin", tags=["admin"])

_viewer_router = APIRouter(dependencies=[Depends(verify_admin_jwt)])
_admin_router = APIRouter(dependencies=[Depends(require_admin)])


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


@_viewer_router.get("/keys", response_model=list[KeyListItem])
async def list_keys() -> list[dict]:
    return await db.list_keys()


@_viewer_router.get("/keys/{key_id}", response_model=KeyListItem)
async def get_key(key_id: int) -> dict:
    record = await db.get_key(key_id)
    if record is None:
        raise HTTPException(status_code=404, detail="密钥不存在")
    return record


@_admin_router.post("/keys")
async def create_key(body: KeyCreateRequest) -> JSONResponse:
    if body.upstream_id is not None:
        up = await db.get_upstream(body.upstream_id)
        if not up:
            raise HTTPException(status_code=400, detail="上游不存在")
    record = await db.create_key(body.name, body.expires_at, body.upstream_id)
    return JSONResponse(content=record)


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


@_admin_router.get("/keys/{key_id}/reveal")
async def reveal_key(key_id: int) -> dict:
    key = await db.get_key_full(key_id)
    if not key:
        raise HTTPException(status_code=404, detail="密钥不存在")
    if not key.get("key"):
        raise HTTPException(
            status_code=410,
            detail="该密钥创建于明文回显功能上线之前，无明文可回显；请新建密钥以获取完整 sk",
        )
    return {"id": key["id"], "key": key["key"]}


@_viewer_router.get("/stats/overview", response_model=OverallStats)
async def stats_overview() -> dict:
    return await db.get_overall_stats()


@_viewer_router.get("/stats/usage", response_model=UsageStats)
async def stats_usage(
    days: int = Query(default=7, ge=1, le=90),
    top: int = Query(default=10, ge=1, le=100),
) -> dict:
    trend = await db.get_usage_trend(days=days)
    by_key = await db.get_usage_by_key(limit=top)
    return {"trend": trend, "by_key": by_key}


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


@_viewer_router.get("/upstreams", response_model=list[UpstreamItem])
async def list_upstreams() -> list[dict]:
    return await db.list_upstreams()


@_viewer_router.get("/upstreams/{upstream_id}", response_model=UpstreamItem)
async def get_upstream(upstream_id: int) -> dict:
    up = await db.get_upstream(upstream_id)
    if not up:
        raise HTTPException(status_code=404, detail="上游不存在")
    return up


@_admin_router.post("/upstreams", response_model=UpstreamItem)
async def create_upstream(body: UpstreamCreateRequest) -> dict:
    return await db.create_upstream(
        body.name, body.base_url, body.api_key, body.protocol, body.is_default, models=body.models
    )


@_admin_router.put("/upstreams/{upstream_id}", response_model=UpstreamItem)
async def update_upstream(upstream_id: int, body: UpstreamUpdateRequest) -> dict:
    ok = await db.update_upstream(
        upstream_id, body.name, body.base_url, body.api_key, body.protocol, body.is_default, models=body.models
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


router.include_router(_viewer_router)
router.include_router(_admin_router)
