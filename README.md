# LLM API Gateway

> 大模型 API 代理网关 + `sk-*` 密钥授权管理，基于 FastAPI 构建，支持流式 SSE 透传与 Docker 一键部署。

## 项目简介

`llm-proxy-tk` 是一个轻量级的大模型 API 网关，部署在你的上游大模型服务（如 vLLM、Ollama、Xinference 等 OpenAI 兼容服务）之前，统一对外提供 `/v1/*` 接口，并为每个调用方发放独立的 `sk-` 密钥进行鉴权与用量追踪。

核心价值：
- **密钥隔离**：上游真实 API Key 不再分发给调用方，所有流量经网关统一鉴权后透传。
- **安全存储**：明文密钥不落库，仅存储 `sha256` 哈希与可展示前缀（形如 `sk-ab12****`）。
- **生命周期管理**：支持密钥发放、列表查询、吊销、过期时间设置与用量统计。
- **流式透传**：完整支持 SSE 流式响应，适配 `chat/completions` 等流式场景。

## 功能特性

- 🔄 反向代理 `/v1/*` 全量透传至上游大模型服务
- 🔐 `sk-` 密钥鉴权（Bearer Token）
- 🛡️ 管理接口 `MASTER_KEY` 保护
- 🗄️ SQLite 持久化，零外部依赖
- 📊 密钥用量统计（最后使用时间、请求次数）
- ⏱️ 密钥过期与吊销
- 🌐 内置 Web 管理界面
- 🐳 Docker 容器化部署

## 架构图

```
调用方 (OpenAI SDK / curl)
        │  Bearer sk-xxxx
        ▼
┌───────────────────────────────────┐
│        LLM API Gateway            │
│  ┌───────────┐   ┌─────────────┐  │
│  │ /v1/* 代理 │──▶│ sk 鉴权校验  │  │
│  └───────────┘   └─────────────┘  │
│  ┌───────────┐   ┌─────────────┐  │
│  │ /admin/*  │   │  Web 管理界面 │  │
│  └───────────┘   └─────────────┘  │
│         │  SQLite (keys.db)        │
└─────────┼─────────────────────────┘
          │  Bearer upstream-key
          ▼
   上游大模型服务 (vLLM / Ollama / ...)
```

## 技术栈

| 层级 | 技术 |
|------|------|
| Web 框架 | FastAPI + Uvicorn |
| HTTP 客户端 | httpx（异步、流式） |
| 数据库 | SQLite + aiosqlite |
| 配置管理 | pydantic-settings |
| 容器化 | Docker (python:3.11-slim) |

## 项目结构

```
llm-proxy-tk/
├── proxy/
│   ├── app/
│   │   ├── main.py        # FastAPI 入口，挂载路由与静态资源
│   │   ├── config.py      # 环境变量配置
│   │   ├── proxy.py       # /v1/* 反向代理（支持流式 SSE）
│   │   ├── auth.py        # sk 鉴权 + MASTER_KEY 校验
│   │   ├── admin.py       # /admin/* 密钥管理接口
│   │   ├── db.py          # SQLite 数据访问层
│   │   ├── schemas.py     # Pydantic 请求/响应模型
│   │   └── static/        # Web 管理界面（HTML/JS/CSS）
│   └── requirements.txt
├── Dockerfile
├── docker-run.example.sh  # 启动示例脚本
└── .dockerignore
```

## 快速开始

### 方式一：Docker 部署（推荐）

1. 构建镜像并启动容器：

```bash
docker build -t llm-api-gateway .

docker run -d \
  --name llm-api-gateway \
  -p 9000:9000 \
  -e MASTER_KEY=change-me-master \
  -e VLLM_TARGET_URL=http://host.docker.internal:8000 \
  -e UPSTREAM_API_KEY=optional-upstream-key \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  llm-api-gateway
```

2. 访问管理界面：<http://localhost:9000>

### 方式二：本地运行

```bash
cd proxy
pip install -r requirements.txt

export MASTER_KEY=change-me-master
export VLLM_TARGET_URL=http://127.0.0.1:8000

uvicorn app.main:app --host 0.0.0.0 --port 9000
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `MASTER_KEY` | ✅ | - | 管理接口与 Web 登录的主密钥 |
| `VLLM_TARGET_URL` | ❌ | `http://127.0.0.1:8000` | 上游大模型服务地址 |
| `UPSTREAM_API_KEY` | ❌ | - | 上游自身开启鉴权时填入 |
| `PROXY_HOST` | ❌ | `0.0.0.0` | 监听地址 |
| `PROXY_PORT` | ❌ | `9000` | 监听端口 |
| `DB_PATH` | ❌ | `data/keys.db` | SQLite 数据库路径 |

## API 接口

### 公开接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/info` | 网关基本信息 |
| GET | `/health` | 健康检查（探测上游可达性） |

### 代理接口（需 `sk-` 密钥）

| 方法 | 路径 | 说明 |
|------|------|------|
| * | `/v1/{path}` | 透传至上游 `/v1/*`，支持 GET/POST/PUT/DELETE/PATCH |

调用示例：

```bash
curl http://localhost:9000/v1/chat/completions \
  -H "Authorization: Bearer sk-你的密钥" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "你的模型名",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 管理接口（需 `MASTER_KEY`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/admin/keys` | 发放新密钥（明文仅返回一次） |
| GET | `/admin/keys` | 密钥列表 |
| GET | `/admin/keys/{id}` | 查询单个密钥 |
| DELETE | `/admin/keys/{id}` | 吊销密钥 |

发放密钥示例：

```bash
curl -X POST http://localhost:9000/admin/keys \
  -H "Authorization: Bearer change-me-master" \
  -H "Content-Type: application/json" \
  -d '{"name": "测试客户端", "expires_at": "2026-12-31T23:59:59+00:00"}'
```

响应：

```json
{
  "id": 1,
  "key": "sk-aBcDeFgHiJkLmNOpQrStUvWxYz123456",
  "name": "测试客户端",
  "status": "active",
  "created_at": "2026-08-13T10:00:00+00:00",
  "expires_at": "2026-12-31T23:59:59+00:00"
}
```

> ⚠️ `key` 字段为明文，**仅在创建时返回一次**，请妥善保存。

## 安全说明

- **密钥不落库**：数据库仅存储 `sha256(明文)`，无法反向还原。
- **前缀脱敏**：列表与查询接口仅返回 `sk-ab12****` 形式的前缀。
- **管理接口隔离**：`/admin/*` 与 `/v1/*` 使用独立密钥体系，互不影响。
- **过期与吊销**：过期或被吊销的密钥立即失效，无法继续调用。

## 许可证

本项目仅供学习与内部使用。
