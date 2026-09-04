"""Pydantic 请求/响应模型。"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field, computed_field


class KeyCreateRequest(BaseModel):
    name: Optional[str] = Field(default=None, description="密钥用途/备注名")
    expires_at: Optional[str] = Field(
        default=None, description="可选过期时间，ISO8601 字符串"
    )
    upstream_id: Optional[int] = Field(default=None, description="绑定的上游 ID，不填则使用默认上游")
    owner_id: Optional[int] = Field(default=None, description="归属用户 ID（普通用户），不填=系统密钥仅管理员可见")


class KeyRenameRequest(BaseModel):
    name: Optional[str] = Field(default=None, description="新的密钥备注名，空表示未命名")


class KeyOwnerRequest(BaseModel):
    owner_id: Optional[int] = Field(default=None, description="归属用户 ID（普通用户）；null/不填=解除归属（系统密钥）")


class KeyCreatedResponse(BaseModel):
    id: int
    key: str
    name: Optional[str] = None
    status: str
    upstream_id: Optional[int] = None
    owner_id: Optional[int] = None
    created_at: str
    expires_at: Optional[str] = None


class KeyListItem(BaseModel):
    id: int
    key_prefix: str
    name: Optional[str] = None
    status: str
    expired: bool = Field(default=False, description="活跃密钥是否已过过期时间（派生状态，不落库）")
    inactive: bool = Field(default=False, description="活跃密钥是否超过 7 天未使用（派生状态，不落库）")
    upstream_id: Optional[int] = None
    owner_id: Optional[int] = None
    owner_name: Optional[str] = None
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
    total_tokens: int = 0
    today_tokens: int = 0
    total_cache_read_tokens: int = 0
    today_cache_read_tokens: int = 0


class UsageTrendItem(BaseModel):
    date: str = Field(description="周期起始日 YYYY-MM-DD，兼容旧字段")
    label: str = Field(default="", description="横轴展示标签，如 09-03 / 09-01周 / 2026-09")
    start: str = Field(default="", description="周期起始日 YYYY-MM-DD")
    end: str = Field(default="", description="周期结束日 YYYY-MM-DD")
    count: int
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


class UsageKeyItem(BaseModel):
    key_id: int
    key_prefix: str
    key_name: Optional[str] = None
    call_count: int
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


class UsageStats(BaseModel):
    trend: list[UsageTrendItem]
    by_key: list[UsageKeyItem]


class UsagePeriod(BaseModel):
    start: str
    end: str
    label: str


class UsageMatrixCell(BaseModel):
    count: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int = 0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


class UsageMatrixRow(BaseModel):
    key_id: int
    key_prefix: str
    key_name: Optional[str] = None
    total_calls: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int = 0
    cells: list[UsageMatrixCell]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


class UsageMatrix(BaseModel):
    granularity: str
    days: int
    periods: list[UsagePeriod]
    rows: list[UsageMatrixRow]


class UpstreamItem(BaseModel):
    id: int
    name: str
    base_url: str
    api_key: str = ""
    protocol: str = "openai"
    models: list[str] = Field(default_factory=list, description="该上游可用模型列表，可空")
    is_default: bool
    inject_include_usage: bool = Field(
        default=False, description="OpenAI 方言流式请求自动补 stream_options.include_usage，用于取回 token 用量"
    )
    created_at: str


class UpstreamCreateRequest(BaseModel):
    name: str
    base_url: str
    api_key: str = ""
    protocol: str = "openai"
    models: list[str] = Field(default_factory=list, description="该上游可用模型列表，可空")
    is_default: bool = False
    inject_include_usage: bool = Field(
        default=False, description="OpenAI 方言流式请求自动补 stream_options.include_usage，用于取回 token 用量"
    )


class UpstreamUpdateRequest(BaseModel):
    name: str
    base_url: str
    api_key: str = ""
    protocol: str = "openai"
    models: list[str] = Field(default_factory=list, description="该上游可用模型列表，可空")
    is_default: bool = False
    inject_include_usage: bool = Field(
        default=False, description="OpenAI 方言流式请求自动补 stream_options.include_usage，用于取回 token 用量"
    )


LoginResponse.model_rebuild()
