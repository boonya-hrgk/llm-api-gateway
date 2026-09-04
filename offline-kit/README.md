# LLM API Gateway 内网离线部署包

> 适用场景：目标机是 **Windows 10 / 11 x64，处于内网、没有互联网**，需要在这台机器上部署运行 `llm-api-gateway` 网关服务。
>
> 本离线包已在开发机用 **2026 年最新版依赖做过真实启动测试**（含建库、管理员登录、JWT 签发），确认可直接安装运行。

---

## 一、这个包里有什么

```
offline-kit\
├── README.md          ← 本文件
├── install.bat        ← 一键安装脚本（双击运行，全程不碰外网）
├── requirements.txt   ← 依赖清单（供 pip 解析用）
└── wheels-win311\     ← 离线依赖包，23 个 wheel，约 4.3MB
```

> wheels 按 **Python 3.11 + win_amd64** 平台锁定下载。目标机必须是这个平台，
> 否则安装会失败（见文末《故障排查》第 3 条）。

---

## 二、开始前要准备的（在有网的机器上完成）

| # | 物品 | 说明 |
|---|---|---|
| 1 | **Python 3.11 x64 安装包** | 官方 `python-3.11.x-amd64.exe`，去 [python.org](https://www.python.org/downloads/windows/) 下载后 U 盘拷到目标机。选 3.11 与本项目 Dockerfile 的 `python:3.11-slim` 一致，生态最稳 |
| 2 | **项目源码** | 至少 `proxy/` 整个目录（网关本体代码 + 管理界面） |
| 3 | **本 `offline-kit/` 目录** | 离线依赖包，随 U 盘一起走 |
| 4 | 内网上游服务地址 | vLLM / Ollama / Xinference 等 OpenAI 兼容服务的地址 + 端口（可选 API Key） |
| 5 | （可选）NSSM | 需要「开机自启 + 崩溃自拉起」时用，`nssm-2.24.zip` 官网可下，支持 Win7+ |

**不需要准备**：
- VC++ 运行库 —— Python 3.11 自带 MSVC 运行库，pydantic-core 等编译型 wheel 可直接运行。
- SHA-2 补丁 —— 那是 Windows 7 的坑，Windows 10 没有此问题。

---

## 三、目标机部署步骤

### 第 1 步：安装 Python 3.11

双击 `python-3.11.x-amd64.exe`，**务必勾选 `Add python.exe to PATH`**，然后 Install Now。

装完开一个 cmd 验证：

```bat
python --version
:: 应显示 Python 3.11.x
```

### 第 2 步：拷贝文件到目标机

```
D:\gateway\            ← 建议放这里，以下步骤按此路径写
├── offline-kit\       ← 整个目录（install.bat / wheels-win311 / requirements.txt）
└── proxy\             ← 项目代码整个目录
```

### 第 3 步：离线安装依赖（一键）

双击 `offline-kit\install.bat`，看到 `[OK] All dependencies installed...` 即成功。

脚本做的事相当于手动执行：

```bat
cd /d D:\gateway\offline-kit
python -m pip install --no-index --find-links=wheels-win311 -r requirements.txt
```

- `--no-index` 强制 pip **只从本地 wheel 目录安装**，任何情况都不会去连外网。
- 安装目标位置是默认 site-packages。若这台机器还要跑别的 Python 项目，想隔离的话，可改用手动方式：先 `python -m venv D:\gateway\venv` 建虚拟环境，再在 **venv 内**执行上面这条 pip 命令。

### 第 4 步：配置网关 `.env`

进入 `proxy\` 目录，把 `.env.example` 复制一份命名为 `.env`（注意 Windows 资源管理器里看不到扩展名，用 `cmd` 执行最稳）：

```bat
copy D:\gateway\proxy\.env.example D:\gateway\proxy\.env
```

用记事本打开 `D:\gateway\proxy\.env`，逐项核对：

| 配置项 | 是否必改 | 说明 |
|---|---|---|
| `VLLM_TARGET_URL` | **必改** | 内网上游地址。与网关同机则 `http://127.0.0.1:8000`；在其它内网机器则填内网 IP，如 `http://192.168.1.50:8000`。**无外网的机器填不了云端 API** |
| `JWT_SECRET` | **强烈建议** | 填一串随机长字符串（如 `openssl rand -hex 32` 的结果）。不设则每次启动随机生成，**重启后所有登录失效** |
| `DEFAULT_ADMIN_PASSWORD` | **强烈建议** | 首次启动创建的默认管理员密码，默认值是 `hrgk@admin`，必须改掉 |
| `UPSTREAM_API_KEY` | 可选 | 上游服务自身开了 api-key 鉴权时填 |
| `PROXY_PORT` | 可选 | 网关监听端口，默认 9000 |
| `DEFAULT_ADMIN_USERNAME` | 可选 | 默认管理员用户名，默认 admin |

### 第 5 步：手动试跑验证

**必须在 `proxy/` 目录内启动**——`.env`、`data/keys.db` 都是相对路径，从别的目录启动会读不到配置、或把数据库建到别处。

```bat
cd /d D:\gateway\proxy
python main.py
```

看到类似 `Uvicorn running on http://0.0.0.0:9000` 的输出即为启动成功。保持窗口开着，在**另一台有浏览器的机器**（或本机）访问：

```
http://<网关机IP>:9000
```

用 admin + 你设置的密码登录。能进管理界面即部署成功。

> **验收清单**：
> - [ ] `python main.py` 启动无报错
> - [ ] 浏览器能打开管理界面并登录
> - [ ] 界面上新增模型 / 发一条测试消息能通（依赖上游地址配置正确）
> - [ ] 关掉试跑窗口后重新启动，登录态依然有效（说明 `JWT_SECRET` 已固定）

### 第 6 步：做成开机自启服务

试跑没问题后，把它注册为 Windows 服务。两种方式任选：

**方式 A：NSSM（推荐，开机自启 + 崩溃自动拉起）**

```bat
nssm install AIGateway C:\Python311\python.exe D:\gateway\proxy\main.py
nssm set AIGateway AppDirectory D:\gateway\proxy
nssm set AIGateway AppStdout D:\gateway\proxy\gateway.log
nssm set AIGateway AppStderr D:\gateway\proxy\gateway.err.log
nssm set AIGateway Start SERVICE_AUTO_START
nssm start AIGateway
```

> 第 2 条 `AppDirectory` 必不可少，否则服务启动时工作目录不对，同样会踩到相对路径的坑。

**方式 B：任务计划程序（不装 NSSM 的备选）**

1. 开始菜单搜「任务计划程序」→ 创建任务
2. 触发器：**登录时** 或 **系统启动时**
3. 操作 → 新建：
   - 程序/脚本：`C:\Python311\python.exe`
   - 添加参数：`D:\gateway\proxy\main.py`
   - 起始于：`D:\gateway\proxy`（关键）
4. 勾选「不管用户是否登录都要运行」

### 第 7 步：放行防火墙（供局域网其它机器访问）

网关机器本身是服务端，别的机器要调它，需放行 9000 端口（在**网关机**上以管理员身份运行 cmd）：

```bat
netsh advfirewall firewall add rule name="LLM Gateway 9000" dir=in action=allow protocol=TCP localport=9000
```

假设网关机内网 IP 是 `192.168.1.10`，调用方把 OpenAI 兼容地址配成：

```
http://192.168.1.10:9000/v1
```

---

## 四、故障排查

| 现象 | 原因 | 对策 |
|---|---|---|
| `python` 不是内部或外部命令 | 装 Python 时没勾 `Add to PATH` | 重装 Python，勾选 Add to PATH；或改用全路径 `C:\Python311\python.exe` |
| install.bat 报 `[ERROR] install failed` | wheels-win311 目录没与 bat 同级 / 平台不匹配 | 确认 `wheels-win311\` 就在 offline-kit 目录内；确认目标机是 **x64 + Python 3.11** |
| install.bat 报 `No matching distribution found` | 目标机不是 cp311/win_amd64 | 看《五》重新生成匹配平台的离线包（32 位系统需另锁旧版 pydantic） |
| 启动后访问不了页面 | 启动目录不对 / 端口被占 | 必须在 `proxy/` 内启动；换端口用 `PROXY_PORT`；查端口占用 `netstat -ano \| findstr 9000` |
| 登录成功但立刻又要求登录 | 没设 `JWT_SECRET`，重启后密钥变了 | 在 `.env` 里固定 `JWT_SECRET` 并重启服务 |
| 页面能进但发消息报 502 / 连接失败 | 上游不通 | 内网机器确认 `VLLM_TARGET_URL` 填的是可达的内网地址；在网关机上 `ping` 上游、用浏览器打开上游地址验证 |
| 局域网其它机器访问超时 | 防火墙没放行 | 按《三·第7步》放行 TCP 9000；确认是管理员 cmd 执行的 |
| 日志在哪看 | — | 手动跑看控制台；NSSM 服务看 `gateway.log` / `gateway.err.log`；页面后端报错也在控制台/日志里 |
| 服务偶发登录失效（时间对不上） | 机器时间不准 | 内网若无时间同步源，至少保证网关机器时间不跳变（JWT 做过期校验） |

---

## 五、重新生成离线包（当目标平台不同 / 依赖升级时）

本离线包按 **cp311 / win_amd64** 生成。换平台时在有网的机器上执行：

```bash
# 用与目标机相同版本的 Python 建虚拟环境解析完整依赖树
python -m venv venv-offline
venv-offline/Scripts/pip install -r proxy/requirements.txt
venv-offline/Scripts/pip freeze > requirements-lock.txt

# 下载 wheel 到本地目录（以下示例为 3.11 x64；32 位系统要另锁旧版 pydantic）
venv-offline/Scripts/pip download -r requirements-lock.txt -d wheels-win \
  --platform win_amd64 --python-version 311 --implementation cp \
  --abi cp311 --only-binary=:all:
```

然后整目录带到目标机，按《三·第3步》的方式用 `--no-index --find-links` 安装。

---

## 六、日常维护

- **更新代码**：网关代码在 `proxy/` 里，覆盖对应文件即可，依赖不用重装。
- **备份数据**：`proxy\data\keys.db` 是 SQLite 库（密钥哈希、用量记录），定期拷贝一份。
- **管理界面离线可用**：前端 marked/highlight/purify 等库已全部打包在本地，无外网 CDN 依赖（已逐行排查确认）。

---

## 七、本包依赖版本

锁定的关键版本（均为 2026 年最新稳定版）：

```
fastapi 0.141.1 · starlette 1.6.0 · uvicorn 0.52.4 · httpx 0.28.1
pydantic 2.13.5 · pydantic-settings 2.15.0 · aiosqlite 0.22.1
```

> 兼容性说明：新版 Starlette 已移除旧事件 API `on_event`，但 FastAPI 自带兼容层，
> 本项目 `@app.on_event("startup")` 仍可正常工作（启动时打一条 deprecation 警告，
> 不影响运行）——已在本离线包对应版本上实测验证。
