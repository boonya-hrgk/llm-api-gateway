"""应用配置：通过环境变量读取。"""
from __future__ import annotations

import secrets
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    jwt_secret: str = ""
    jwt_expire_hours: int = 24
    default_admin_username: str = "admin"
    default_admin_password: str = "hrgk@admin"
    master_key: str = ""
    vllm_target_url: str = "http://127.0.0.1:8000"
    upstream_api_key: str = ""
    proxy_host: str = "0.0.0.0"
    proxy_port: int = 9000
    db_path: str = "data/keys.db"

    @property
    def db_file(self) -> Path:
        p = Path(self.db_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def effective_jwt_secret(self) -> str:
        if self.jwt_secret:
            return self.jwt_secret
        if not hasattr(self, "_generated_jwt_secret"):
            self._generated_jwt_secret = secrets.token_urlsafe(32)
        return self._generated_jwt_secret


settings = Settings()
