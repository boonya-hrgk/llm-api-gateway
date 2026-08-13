"""应用配置：通过环境变量读取。"""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # 管理 /admin/* 接口的 master 密钥（必填）
    master_key: str = ""

    # 上游大模型服务地址（已运行的 vLLM 等 OpenAI 兼容服务）
    vllm_target_url: str = "http://127.0.0.1:8000"

    # 上游若自身开启 api-key 鉴权，填这里；未设则转发时不带 Authorization
    upstream_api_key: str = ""

    proxy_host: str = "0.0.0.0"
    proxy_port: int = 9000

    # SQLite 数据库路径
    db_path: str = "data/keys.db"

    @property
    def db_file(self) -> Path:
        p = Path(self.db_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p


settings = Settings()
