"""鉴权依赖：API-key(sk) 校验 与 Admin JWT 校验。

JWT 使用 Python 标准库实现，无需额外依赖。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone

from fastapi import Depends, Header, HTTPException, status

from . import db
from .config import settings


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    rem = len(data) % 4
    if rem:
        data += "=" * (4 - rem)
    return base64.urlsafe_b64decode(data)


def _jwt_encode(payload: dict, secret: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    header_json = json.dumps(header, separators=(",", ":")).encode("utf-8")
    payload_json = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    header_b64 = _b64url_encode(header_json)
    payload_b64 = _b64url_encode(payload_json)
    signing_input = f"{header_b64}.{payload_b64}".encode("utf-8")
    signature = hmac.new(
        secret.encode("utf-8"), signing_input, hashlib.sha256
    ).digest()
    signature_b64 = _b64url_encode(signature)
    return f"{header_b64}.{payload_b64}.{signature_b64}"


def _jwt_decode(token: str, secret: str) -> dict:
    try:
        header_b64, payload_b64, signature_b64 = token.split(".")
    except ValueError:
        raise ValueError("无效的令牌格式")

    signing_input = f"{header_b64}.{payload_b64}".encode("utf-8")
    expected_sig = hmac.new(
        secret.encode("utf-8"), signing_input, hashlib.sha256
    ).digest()
    actual_sig = _b64url_decode(signature_b64)
    if not hmac.compare_digest(expected_sig, actual_sig):
        raise ValueError("签名验证失败")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except (json.JSONDecodeError, ValueError):
        raise ValueError("无效的载荷数据")

    exp = payload.get("exp")
    if exp is not None:
        if int(datetime.now(timezone.utc).timestamp()) > int(exp):
            raise ValueError("令牌已过期")

    return payload


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


def _parse_expires_at(value: str) -> datetime:
    """解析存储的过期时间字符串。

    兼容旧数据 / 部分前端以 ISO 带 'Z' 的 UTC 形式（如 2026-12-31T23:59:00.000Z）写入的情况：
    Python 3.10 的 datetime.fromisoformat 不识别末尾 'Z'，先规范为 '+00:00' 再解析。
    调用方负责捕获 ValueError。
    """
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


async def verify_api_key(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> dict:
    """API Key 鉴权，兼容两种客户端习惯：

    - OpenAI 方言客户端：`Authorization: Bearer sk-xxx`
    - Anthropic 方言客户端（Claude Code 等）：`x-api-key: sk-xxx`
    """
    if x_api_key and x_api_key.startswith("sk-"):
        plain = x_api_key.strip()
    else:
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
            exp = _parse_expires_at(expires_at)
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if exp < datetime.now(timezone.utc):
                raise HTTPException(status_code=401, detail="API Key 已过期")
        except ValueError:
            raise HTTPException(status_code=401, detail="API Key 过期配置异常")
    # 记录调用并把 usage_logs 行 id 挂到返回记录上，供代理在拿到上游
    # usage 后回填 token 用量（见 db.update_usage_log）
    usage_log_id = await db.record_usage(record["id"])
    record["_usage_log_id"] = usage_log_id
    return record


def create_admin_jwt(user_id: int, username: str, role: str = "viewer") -> tuple[str, int]:
    expire_seconds = settings.jwt_expire_hours * 3600
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=expire_seconds)).timestamp()),
        "type": "admin",
    }
    token = _jwt_encode(payload, settings.effective_jwt_secret)
    return token, expire_seconds


async def verify_admin_jwt(authorization: str | None = Header(default=None)) -> dict:
    token = _parse_bearer(authorization)
    try:
        payload = _jwt_decode(token, settings.effective_jwt_secret)
    except ValueError as e:
        msg = str(e)
        if "过期" in msg:
            raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
        raise HTTPException(status_code=401, detail="无效的访问令牌")

    if payload.get("type") != "admin":
        raise HTTPException(status_code=401, detail="无效的访问令牌")

    user_id = int(payload.get("sub", 0))
    username = payload.get("username", "")
    role = payload.get("role", "viewer")
    if not user_id or not username:
        raise HTTPException(status_code=401, detail="无效的访问令牌")

    user = await db.get_admin_by_username(username)
    if not user or user["id"] != user_id:
        raise HTTPException(status_code=401, detail="账号不存在或已被删除")

    return {"id": user_id, "username": username, "role": user.get("role", role)}


async def require_admin(current_user: dict = Depends(verify_admin_jwt)) -> dict:
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="权限不足，仅管理员可操作")
    return current_user
