"""Pydantic 请求/响应模型。"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class KeyCreateRequest(BaseModel):
    name: Optional[str] = Field(default=None, description="密钥用途/备注名")
    expires_at: Optional[str] = Field(
        default=None, description="可选过期时间，ISO8601 字符串"
    )
    upstream_id: Optional[int] = Field(default=None, description="绑定的上游 ID，不填则使用默认上游")


class KeyCreatedResponse(BaseModel):
    id: int
    key: str
    name: Optional[str] = None
    status: str
    upstream_id: Optional[int] = None
    created_at: str
    expires_at: Optional[str] = None


class KeyListItem(BaseModel):
    id: int
    key_prefix: str
    name: Optional[str] = None
    status: str
    upstream_id: Optional[int] = None
    created_at: str
    expires_at: Optional[str] = None
    last_used_at: Optional[str] = None
    request_count: int


class Message(BaseModel):
    message: str


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: "UserInfo"


class UserInfo(BaseModel):
    id: int
    username: str
    role: str


class UserCreateRequest(BaseModel):
    username: str
    password: str
    role: str = Field(default="viewer", description="admin 或 viewer")


class UserUpdateRequest(BaseModel):
    role: Optional[str] = None
    password: Optional[str] = None


class UserListItem(BaseModel):
    id: int
    username: str
    role: str
    created_at: str
    last_login_at: Optional[str] = None


class OverallStats(BaseModel):
    total_keys: int
    active_keys: int
    total_users: int
    total_calls: int
    today_calls: int


class UsageTrendItem(BaseModel):
    date: str
    count: int


class UsageKeyItem(BaseModel):
    key_id: int
    key_prefix: str
    key_name: Optional[str] = None
    call_count: int


class UsageStats(BaseModel):
    trend: list[UsageTrendItem]
    by_key: list[UsageKeyItem]


class UpstreamItem(BaseModel):
    id: int
    name: str
    base_url: str
    api_key: str = ""
    protocol: str = "openai"
    models: list[str] = Field(default_factory=list, description="该上游可用模型列表，可空")
    is_default: bool
    created_at: str


class UpstreamCreateRequest(BaseModel):
    name: str
    base_url: str
    api_key: str = ""
    protocol: str = "openai"
    models: list[str] = Field(default_factory=list, description="该上游可用模型列表，可空")
    is_default: bool = False


class UpstreamUpdateRequest(BaseModel):
    name: str
    base_url: str
    api_key: str = ""
    protocol: str = "openai"
    models: list[str] = Field(default_factory=list, description="该上游可用模型列表，可空")
    is_default: bool = False


LoginResponse.model_rebuild()
