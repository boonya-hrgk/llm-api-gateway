# JWT 账号密码登录改造方案

## 一、现状与问题

### 当前实现
- 管理界面只有一个 `MASTER_KEY` 输入框，直接当 Bearer Token 用
- 后端 `verify_master_key` 直接比较字符串相等，没有真正的鉴权体系
- 前端把 MASTER_KEY 明文存在 `sessionStorage` 里，每次请求都带着
- **密钥明文不显示**的 bug 后端已修复（`JSONResponse` 替代 `response_model`），但前端未升级

### 用户诉求
1. 用**账号密码**登录，而不是一个裸 key
2. 用 **JWT** 做鉴权令牌，专业且安全
3. 不要明文存敏感信息

---

## 二、改造方案总览

```
当前:  前端输入 MASTER_KEY → 直接当 Bearer Token → 后端字符串比较
改造后: 前端输入 账号+密码 → POST /admin/login → 返回 JWT → 后续请求带 JWT
```

### 核心改动
1. **数据库**：新增 `admin_users` 表，存用户名 + 密码哈希
2. **后端**：新增 `/admin/login` 接口，返回 JWT；`verify_master_key` 改为 JWT 校验
3. **前端**：登录框改成用户名+密码，调登录接口拿 JWT，存 token
4. **初始化**：首次启动自动创建默认管理员账号（admin / hrgk@admin），并提示修改

---

## 三、需要修改的文件

### 后端
| 文件 | 改动 |
|------|------|
| `proxy/app/config.py` | 新增 `jwt_secret`、`jwt_expire_hours` 配置 |
| `proxy/app/db.py` | 新增 `admin_users` 表 + 管理员 CRUD + 密码哈希 |
| `proxy/app/auth.py` | 新增 JWT 签发/校验，替换 `verify_master_key` 为 `verify_admin_jwt` |
| `proxy/app/admin.py` | 新增 `/admin/login` 路由；依赖改用 JWT 校验 |
| `proxy/app/schemas.py` | 新增 `LoginRequest`、`LoginResponse` 模型 |
| `proxy/requirements.txt` | 新增 `pyjwt` 依赖 |
| `proxy/.env.example` | 新增 `JWT_SECRET`、`DEFAULT_ADMIN_USERNAME`、`DEFAULT_ADMIN_PASSWORD` |

### 前端
| 文件 | 改动 |
|------|------|
| `proxy/app/static/index.html` | 登录框从单输入改为用户名+密码两个输入 |
| `proxy/app/static/app.js` | 登录逻辑改为调 `/admin/login` 拿 JWT，token 存 sessionStorage |
| `proxy/app/static/styles.css` | 登录样式微调（可选） |

---

## 四、详细改造步骤

### 步骤 1：配置层（config.py）
- 新增 `jwt_secret`：JWT 签名密钥，从环境变量读取，默认随机生成（启动时打印警告）
- 新增 `jwt_expire_hours`：Token 过期时间，默认 24 小时
- `master_key` 标记为「已废弃，兼容旧配置」

### 步骤 2：数据层（db.py）
- 新增 `admin_users` 表：
  ```sql
  CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_login_at TEXT
  );
  ```
- 新增函数：
  - `hash_password(password)` → SHA256 + salt（或直接用 hashlib.pbkdf2_hmac）
  - `verify_password(password, password_hash)` → 布尔
  - `create_admin_user(username, password)` → 创建管理员
  - `get_admin_by_username(username)` → 查询管理员
  - `update_admin_last_login(user_id)` → 更新最后登录时间
  - `init_default_admin()` → 首次启动创建默认管理员（admin / hrgk@admin）

### 步骤 3：鉴权层（auth.py）
- 新增 `create_jwt(user_id, username)` → 生成 JWT（HS256）
- 新增 `verify_admin_jwt` → FastAPI 依赖，从 Authorization 头解析并校验 JWT
- `verify_master_key` → 保留但标记 deprecated，兼容旧配置

### 步骤 4：路由层（admin.py + schemas.py）
- 新增 `POST /admin/login`：
  - 入参：`{ username, password }`
  - 出参：`{ access_token, token_type, expires_in }`
- 所有 `/admin/*` 路由的依赖从 `verify_master_key` 改为 `verify_admin_jwt`
- schemas 新增 `LoginRequest`、`LoginResponse`

### 步骤 5：前端登录页（index.html）
- 登录框从单个「MASTER_KEY」输入改为：
  - 用户名输入框（type="text"，默认值 admin）
  - 密码输入框（type="password"）
  - 登录按钮

### 步骤 6：前端逻辑（app.js）
- 登录表单提交 → `POST /admin/login` → 拿到 `access_token` → 存 sessionStorage
- `api()` 函数的 Authorization 头继续用 Bearer 方式（不变）
- 登出逻辑不变

### 步骤 7：启动初始化（main.py startup）
- 调用 `init_default_admin()`：
  - 如果 `admin_users` 表为空，创建默认账号 `admin / hrgk@admin`
  - 控制台打印警告提示修改默认密码

---

## 五、依赖变更

新增 `pyjwt` 到 `requirements.txt`：
```
pyjwt>=2.8
```

> 密码哈希用 Python 标准库 `hashlib.pbkdf2_hmac`，不需要额外依赖。

---

## 六、风险与注意事项

| 风险 | 应对 |
|------|------|
| 默认密码 `hrgk@admin` 太弱 | 首次启动控制台警告；前端登录后提示修改密码（后续迭代） |
| JWT Secret 未配置 | 启动时自动生成随机值并打印警告（重启会失效，生产必须配置） |
| 旧用户用 `MASTER_KEY` 升级后登不进去 | 保留 `MASTER_KEY` 兼容模式：如果配置了 `MASTER_KEY` 且没有管理员账号，用 master key 也能登录 |
| 密码哈希算法选择 | 用标准库 `pbkdf2_hmac(sha256, 100000 iterations)`，安全且无额外依赖 |

---

## 七、验收标准

1. 启动服务后，访问管理界面看到「用户名 + 密码」登录框
2. 使用默认账号 `admin / hrgk@admin` 能登录成功
3. 登录后能正常创建密钥，**弹窗正确显示明文密钥**
4. 关闭浏览器标签页后重新打开，需要重新登录（sessionStorage 行为）
5. Token 过期后请求返回 401，自动跳回登录页
6. `/v1/*` 代理接口的 `sk-` 密钥鉴权不受影响
