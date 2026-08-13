# FastAPI 大模型 API 代理 + sk 授权管理

## Summary

今天的开发任务**只做两件事**：
1. **API 代理**：用 Python FastAPI 实现一个 OpenAI 兼容的反向代理，把外部对 `http://ip:9000/v1/*` 的请求转发到已在运行的大模型服务（vLLM，默认 `http://127.0.0.1:8000`），完整透传含流式 SSE 在内的响应。
2. **sk 授权管理**：对调用方做 API-key（`sk-xxx`）鉴权——无 key 或非法 key 一律 401；提供 SQLite 持久化的密钥注册/发放/吊销管理，以及一个 `MASTER_KEY` 保护的 Admin HTTP 接口和**简洁美观大气的 Web 管理界面**。

不在本次范围内：vLLM 本身的部署、模型文件、supervisord、GPU 等——大模型服务视为已存在，代理通过环境变量 `VLLM_TARGET_URL` 指向它。

## Architecture

```
外部应用/客户端 --(9000, Bearer sk-xxx)--> FastAPI 代理 --(VLLM_TARGET_URL, 可选上游 key)--> 已运行的 vLLM 大模型服务
                                            |
                                      SQLite (keys.db)
                                            |
                            Web UI(/) + Admin API(/admin/*, Bearer MASTER_KEY)
```

- 代理是 LLM 服务对外的**唯一受控入口**：所有 `/v1/*` 必须带有效 sk。
- 上游 vLLM 若自身也开了 `--api-key`，设 `UPSTREAM_API_KEY`，代理转发时用该 key 替换请求头；未设则不带 Authorization 转发。
- 鉴权一律在后端强制；Web UI 只是后端接口的调用方，脚本/第三方应用直调接口同样受保护。

## 目录结构

```
/workspace/
├── Dockerfile                    # 仅打包代理服务(python:3.11-slim)
├── .dockerignore
├── docker-run.example.sh         # 启动示例(含环境变量说明)
└── proxy/
    ├── requirements.txt
    ├── app/
    │   ├── __init__.py
    │   ├── main.py               # FastAPI 应用、路由挂载、静态资源挂载、健康检查
    │   ├── config.py             # 环境变量配置
    │   ├── db.py                 # SQLite 初始化与密钥 CRUD
    │   ├── auth.py               # sk 校验依赖 + Admin 鉴权依赖
    │   ├── schemas.py            # Pydantic 请求/响应模型
    │   ├── admin.py              # /admin/keys 路由
    │   ├── proxy.py              # /v1/* 代理转发路由(含流式)
    │   └── static/               # Web 管理界面(纯静态，无构建)
    │       ├── index.html
    │       ├── styles.css
    │       └── app.js
```

## Proposed Changes

### 1. `proxy/requirements.txt`
`fastapi>=0.110`、`uvicorn[standard]`、`httpx`、`aiosqlite`、`pydantic-settings`。

### 2. `proxy/app/config.py`
用 `pydantic-settings` 读取：
- `MASTER_KEY`（必填，保护 /admin/*）
- `VLLM_TARGET_URL` 默认 `http://127.0.0.1:8000`
- `UPSTREAM_API_KEY`（可选，上游 vLLM 自身 api-key）
- `PROXY_HOST` 默认 `0.0.0.0`、`PROXY_PORT` 默认 `9000`
- `DB_PATH` 默认 `data/keys.db`（容器内 `/app/data/keys.db`）

### 3. `proxy/app/db.py`
`aiosqlite` 异步访问。表：
```sql
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT UNIQUE NOT NULL,        -- sha256(明文)，不存明文
    key_prefix TEXT NOT NULL,             -- 形如 sk-ab12**** 仅展示
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active',-- active | revoked
    created_at TEXT NOT NULL,
    expires_at TEXT,                       -- 可选过期(ISO8601)
    last_used_at TEXT,
    request_count INTEGER NOT NULL DEFAULT 0
);
```
异步函数：`init_db()`、`create_key(name, expires_at)`（生成 `sk-`+32 位 urlsafe token，明文仅返回一次）、`get_key_by_hash`、`list_keys`、`revoke_key(id)`、`record_usage(id)`。

### 4. `proxy/app/auth.py`
- `verify_api_key`（Depends）：从 `Authorization: Bearer <key>` 取 key → sha256 → 查库 → 校验 `active` 且未过期；失败 401 JSON。成功异步更新 `last_used_at`/`request_count`。
- `verify_master_key`（Depends）：校验 `Bearer <MASTER_KEY>`，失败 401。用于 `/admin/*`。

### 5. `proxy/app/schemas.py`
`KeyCreateRequest{name?,expires_at?}`、`KeyCreatedResponse{id,key,name,created_at,expires_at}`、`KeyListItem{id,key_prefix,name,status,created_at,expires_at,last_used_at,request_count}`。

### 6. `proxy/app/admin.py`
路由前缀 `/admin`，全部依赖 `verify_master_key`：
- `POST /admin/keys` —— 创建并发放，明文 key **仅此一次**返回。
- `GET /admin/keys` —— 列出全部（仅 prefix + 元数据）。
- `GET /admin/keys/{id}` —— 查单个。
- `DELETE /admin/keys/{id}` —— 吊销（`status='revoked'`，不删记录）。

### 7. `proxy/app/proxy.py`
- `GET /health` —— 无鉴权，透传上游 `/health`，用于容器健康检查（上游不可达时返回 502）。
- 路由 `/v1/{path:path}`（POST/GET），依赖 `verify_api_key`：
  - `httpx.AsyncClient` 转发原始 method/path/query/body 与除 Authorization 外的 header 到 `VLLM_TARGET_URL`；Authorization 头：`UPSTREAM_API_KEY` 设了就用它，否则不带。
  - **流式**：`stream=true` 响应用 httpx stream + `StreamingResponse` 透传 `text/event-stream`，逐块下发不被缓冲。
  - 透传上游状态码与响应头；上游连接错误返回 502。

### 8. Web 管理界面 `proxy/app/static/`
纯静态单页（原生 HTML+CSS+JS，**无构建、无 CDN、离线可用**），简洁美观大气：卡片式仪表盘、柔和阴影、圆角、深色为主可切浅色、响应式。
- **`index.html`**：左侧导航 + 顶部栏，四个视图：
  - **登录**：输入 `MASTER_KEY` 存 `sessionStorage`，后续请求自动带 `Authorization: Bearer <MASTER_KEY>`，失败留登录页并提示。
  - **概览**：统计卡片（密钥总数、活跃、已吊销、累计调用次数），数据来自 `GET /admin/keys` 聚合。
  - **密钥管理**：表格列 prefix/名称/状态/创建/过期/最近使用/调用次数；行内「吊销」(二次确认)；「新建密钥」模态框(名称+可选过期) → 提交后**仅一次**展示完整 key + 一键复制。
  - **调用测试**：填一个 `sk-xxx`、选模型、输入 prompt、可勾 stream，调 `POST /v1/chat/completions`；流式逐 token 渲染，非流式展示 JSON；用于自测代理与上游模型。
- **`styles.css`**：CSS 变量定义色板/间距/圆角；卡片、表格、按钮、模态框、状态徽章(active 绿/revoked 红)、Toast、加载占位；移动端自适应。
- **`app.js`**：`api(path,opts)` 自动注入鉴权头 + 401 自动退回登录；视图切换、渲染、复制剪贴板、确认弹窗、SSE 流式解析(`fetch`+`ReadableStream`)。
- 由 FastAPI `StaticFiles` 挂载在 `/`，`GET /` 返回 `index.html`；`/health`、`/admin`、`/v1` 路由优先于静态挂载。

### 9. `proxy/app/main.py`
创建 FastAPI 应用，startup 中 `init_db()`；挂载 `admin`、`proxy` 路由；`app.mount("/", StaticFiles(directory="app/static", html=True))` 托管 UI（路由优先级保证 API 不被静态拦截）。`uvicorn app.main:app` 由 Dockerfile CMD 拉起。

### 10. `Dockerfile`（仅代理服务）
```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY proxy/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY proxy/ .
RUN mkdir -p /app/data
ENV PROXY_PORT=9000 DB_PATH=/app/data/keys.db
EXPOSE 9000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9000"]
```

### 11. `.dockerignore`
排除 `.git`、`__pycache__`、`*.pyc`、`.trae`、`data/` 等。

### 12. `docker-run.example.sh`
启动示例与说明：
```bash
docker build -t llm-api-gateway .
docker run -d -p 9000:9000 \
  -e MASTER_KEY=change-me-master \
  -e VLLM_TARGET_URL=http://host.docker.internal:8000 \
  -e UPSTREAM_API_KEY=optional-upstream-key \
  -v $(pwd)/data:/app/data \
  --name llm-api-gateway llm-api-gateway
```

## Assumptions & Decisions

- **范围**：只做「代理 + sk 授权管理 + 管理 UI」；大模型服务（vLLM）已存在，代理经 `VLLM_TARGET_URL` 指向它，不涉及模型/部署/GPU。
- **端口**：代理对外 `0.0.0.0:9000`；上游默认 `http://127.0.0.1:8000`，可改。
- **密钥安全**：SQLite 只存 sha256 + prefix，明文 key 仅创建时返回一次；丢失需重新生成。
- **上游鉴权**：`UPSTREAM_API_KEY` 可选；设了则代理用它替换请求头转发，未设则不带 Authorization。
- **不做复杂限流**：聚焦“key 校验 + 管理发放”解决滥用；仅记 `request_count`/`last_used_at` 便于审计，不实现令牌桶（避免过度设计）。
- **流式**：必须正确透传 SSE，否则流式补全失效——已纳入。
- **UI 形态**：纯静态单页、无构建/无 CDN、离线可用，由 FastAPI 托管；鉴权在后端强制，脚本与第三方应用直调接口同样受保护。

## Verification Steps

1. **本地起服务**（不依赖 Docker 也可测）：`cd proxy && pip install -r requirements.txt && MASTER_KEY=test-master VLLM_TARGET_URL=http://127.0.0.1:8000 uvicorn app.main:app --port 9000`。
2. **无 key 失败**：`curl -X POST http://localhost:9000/v1/chat/completions -d '{...}'` → 401。
3. **非法 key 失败**：`Authorization: Bearer sk-invalid` → 401。
4. **发放 key**：`curl -X POST http://localhost:9000/admin/keys -H "Authorization: Bearer test-master" -d '{"name":"test"}'` → 返回明文 sk。
5. **合法 key 成功**：用该 sk 调 `/v1/chat/completions`（流式与非流式各一次）→ 200，内容来自上游 vLLM。
6. **吊销失效**：`DELETE /admin/keys/{id}` 后再用该 sk → 401。
7. **持久化**：重启进程后 key 仍可用，已吊销 key 仍被拒（SQLite 文件保留）。
8. **Web 界面**：浏览器开 `http://ip:9000/` → 登录 `MASTER_KEY`；概览与密钥列表正常；新建并复制 sk；测试控制台用该 sk 发 chat 请求(流式+非流式)正常返回；吊销后状态变红且再调用 401。
9. **外部对接**：任意 OpenAI 兼容客户端指向 `http://ip:9000/v1`、`api_key` 填发放的 sk，可正常对话。
10. **Docker 打包**：`docker build -t llm-api-gateway .` 后按示例 `docker run`，重复 2-9 验证。
