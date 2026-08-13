"""鉴权依赖：API-key(sk) 校验 与 Admin(master) 校验。"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, status

from . import db
from .config import settings


def _parse_bearer(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="缺少 Authorization 头",
            headers={"WWW-Authenticate": "Bearer"},
        )
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization 格式应为 Bearer <token>",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return parts[1].strip()


async def verify_api_key(authorization: str | None = Header(default=None)) -> dict:
    """校验调用方的 sk。成功返回 key 记录，并异步累计用量。"""
    plain = _parse_bearer(authorization)
    key_hash = hashlib.sha256(plain.encode("utf-8")).hexdigest()
    record = await db.get_key_by_hash(key_hash)
    if record is None:
        raise HTTPException(status_code=401, detail="无效的 API Key")
    if record["status"] != "active":
        raise HTTPException(status_code=401, detail="API Key 已被吊销")
    expires_at = record.get("expires_at")
    if expires_at:
        try:
            exp = datetime.fromisoformat(expires_at)
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if exp < datetime.now(timezone.utc):
                raise HTTPException(status_code=401, detail="API Key 已过期")
        except ValueError:
            # 过期时间格式非法，保守拒绝
            raise HTTPException(status_code=401, detail="API Key 过期配置异常")
    await db.record_usage(record["id"])
    return record


async def verify_master_key(authorization: str | None = Header(default=None)) -> None:
    """校验管理接口的 MASTER_KEY。"""
    if not settings.master_key:
        raise HTTPException(
            status_code=500,
            detail="服务端未配置 MASTER_KEY，管理接口不可用",
        )
    token = _parse_bearer(authorization)
    if token != settings.master_key:
        raise HTTPException(status_code=401, detail="MASTER_KEY 无效")
