"""Pydantic 请求/响应模型。"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class KeyCreateRequest(BaseModel):
    name: Optional[str] = Field(default=None, description="密钥用途/备注名")
    expires_at: Optional[str] = Field(
        default=None, description="可选过期时间，ISO8601 字符串"
    )


class KeyCreatedResponse(BaseModel):
    id: int
    key: str
    name: Optional[str] = None
    status: str
    created_at: str
    expires_at: Optional[str] = None


class KeyListItem(BaseModel):
    id: int
    key_prefix: str
    name: Optional[str] = None
    status: str
    created_at: str
    expires_at: Optional[str] = None
    last_used_at: Optional[str] = None
    request_count: int


class Message(BaseModel):
    message: str
