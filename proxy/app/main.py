"""FastAPI 应用入口：挂载代理、管理路由与 Web 管理界面。"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import db
from .admin import router as admin_router
from .config import settings
from .proxy import router as proxy_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("llm-gateway")

app = FastAPI(
    title="LLM API Gateway",
    description="大模型 API 代理 + sk 授权管理",
    version="1.0.0",
)


@app.on_event("startup")
async def _startup() -> None:
    if not settings.master_key:
        logger.warning(
            "未配置 MASTER_KEY，/admin/* 与 Web 登录将不可用。"
            "请用 -e MASTER_KEY=xxx 指定。"
        )
    else:
        logger.info("MASTER_KEY 已配置，管理接口可用。")
    await db.init_db()
    logger.info("数据库已初始化: %s", settings.db_file)
    logger.info("上游目标: %s", settings.vllm_target_url)


@app.get("/api/info")
async def info() -> dict:
    """返回网关基本信息（不涉密）。"""
    return {
        "name": "LLM API Gateway",
        "version": "1.0.0",
        "target": settings.vllm_target_url,
        "admin_enabled": bool(settings.master_key),
    }


# 1) 先注册 API 路由，确保优先于静态资源匹配
app.include_router(proxy_router)
app.include_router(admin_router)

# 2) 最后挂载静态 Web 管理界面到根路径
_static_dir = Path(__file__).parent / "static"
if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(_static_dir), html=True), name="static")
else:
    logger.warning("静态目录不存在: %s，Web 界面不可用", _static_dir)
