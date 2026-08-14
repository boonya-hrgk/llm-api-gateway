"""一键启动入口：直接 python main.py 即可运行。"""
from __future__ import annotations

import socket
import sys

import uvicorn

from app.config import settings


def _port_in_use(host: str, port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            s.bind((host, port))
        return False
    except OSError:
        return True


if __name__ == "__main__":
    print("=" * 58)
    print("  AI Gateway 授权管理系统  启动中...")
    print(f"  监听地址: http://{settings.proxy_host}:{settings.proxy_port}")
    print(f"  上游服务: {settings.vllm_target_url}")
    print(f"  数据库:   {settings.db_file}")
    print(f"  默认账号: {settings.default_admin_username} / {settings.default_admin_password}")
    print("=" * 58)
    print("  管理界面: http://localhost:" + str(settings.proxy_port))
    print("  按 Ctrl+C 停止服务")
    print("=" * 58)

    if _port_in_use(settings.proxy_host, settings.proxy_port):
        print()
        print(f"  [错误] 端口 {settings.proxy_port} 已被占用！")
        print("  可能原因：服务已在后台运行，或其他程序占用了该端口。")
        print("  解决方法：")
        print("    1. 关闭之前启动的服务（或重启终端）")
        print("    2. 修改环境变量 PROXY_PORT 使用其他端口")
        print()
        sys.exit(1)

    uvicorn.run(
        "app.main:app",
        host=settings.proxy_host,
        port=settings.proxy_port,
        reload=False,
    )
