"""FastAPI 应用入口：挂载代理、管理路由与 Web 管理界面。"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from . import db
from .admin import router as admin_router
from .config import settings
from .proxy import router as proxy_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ai-gateway")

app = FastAPI(
    title="AI Gateway 授权管理系统",
    description="大模型 API 网关 · 密钥管理 · 用量统计",
    version="1.1.0",
)


@app.on_event("startup")
async def _startup() -> None:
    await db.init_db()
    logger.info("数据库已初始化: %s", settings.db_file)

    created = await db.init_default_admin()
    if created:
        logger.warning(
            "已创建默认管理员账号: %s / %s",
            settings.default_admin_username,
            settings.default_admin_password,
        )
        logger.warning("请登录后及时修改默认密码！")
    else:
        logger.info("管理员账号已存在")

    if not settings.jwt_secret:
        logger.warning(
            "未配置 JWT_SECRET，每次启动会自动生成随机值，"
            "重启后所有已登录用户将失效。"
            "生产环境请务必配置 JWT_SECRET。"
        )

    logger.info("上游目标: %s", settings.vllm_target_url)


@app.get("/api/info")
async def info() -> dict:
    """返回网关基本信息（不涉密）。"""
    return {
        "name": "LLM API Gateway 大模型API网关系统",
        "version": "1.1.0",
        "target": settings.vllm_target_url,
        "admin_enabled": True,
    }


@app.middleware("http")
async def _no_store_admin(request: Request, call_next):
    """管理后台 API 动态数据（密钥列表/reveal 等）禁止任何缓存，
    避免浏览器缓存陈旧密钥状态导致误报（如 410）。"""
    resp = await call_next(request)
    if request.url.path.startswith("/admin/") or request.url.path.startswith("/admin"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# 1) 先注册 API 路由，确保优先于静态资源匹配
app.include_router(proxy_router)
app.include_router(admin_router)

# 2) 最后挂载静态 Web 管理界面到根路径
_static_dir = Path(__file__).parent / "static"
if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(_static_dir), html=True), name="static")
else:
    logger.warning("静态目录不存在: %s，Web 界面不可用", _static_dir)
