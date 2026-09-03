"""SQLite 数据访问层：API-key 的持久化与 CRUD。

安全策略：数据库存储 key 的 sha256 哈希（用于网关鉴权）与明文 sk（用于管理员回显/内部对话测试）。
明文 sk 与 upstreams 表的 api_key 同等看待：仅内网管理后台可读，管理员是密钥的合法持有者，
新建密钥后会回显一次，之后管理员仍可在后台"查看密钥"取回（reveal）；密钥丢失或泄露时可在后台
"重置"（替换为一把新明文，旧值立即失效，无明文遗留的旧密钥也可借此获得新明文）。鉴权链路只比对哈希。
管理员密码使用 pbkdf2_hmac 哈希存储。
"""
from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import aiosqlite

from .config import settings

# 用量聚合支持的统计粒度
GRANULARITIES = ("day", "week", "month")

SCHEMA = """
CREATE TABLE IF NOT EXISTS upstreams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT DEFAULT '',
    protocol TEXT NOT NULL DEFAULT 'openai',
    models TEXT NOT NULL DEFAULT '[]',
    is_default INTEGER NOT NULL DEFAULT 0,
    inject_include_usage INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT UNIQUE NOT NULL,
    key TEXT,
    key_prefix TEXT NOT NULL,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    upstream_id INTEGER,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    request_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at TEXT NOT NULL,
    last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id INTEGER NOT NULL,
    key_prefix TEXT NOT NULL,
    key_name TEXT,
    request_time TEXT NOT NULL,
    date_str TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_date ON usage_logs(date_str);
CREATE INDEX IF NOT EXISTS idx_usage_logs_key_id ON usage_logs(key_id);
"""

_PBKDF2_ITERATIONS = 100_000
_PBKDF2_ALGO = "sha256"
_SALT_LEN = 16


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_key(plain: str) -> str:
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()


def _prefix_of(plain: str) -> str:
    head = plain[:8]
    return f"{head}{'*' * 4}"


def _models_to_text(models) -> str:
    """上游模型列表 → 存储用 JSON 字符串（去空、去重、保序）。"""
    if models is None:
        return "[]"
    if isinstance(models, str):
        return models
    out: list[str] = []
    for m in models:
        s = str(m).strip()
        if s and s not in out:
            out.append(s)
    return json.dumps(out, ensure_ascii=False)


def _models_from_text(raw) -> list[str]:
    """存储的 models 文本 → 模型列表；兼容 JSON 数组与历史脏数据。"""
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        data = []
        for piece in str(raw).replace(",", " ").split():
            piece = piece.strip()
            if piece:
                data.append(piece)
    if isinstance(data, list):
        return [str(x).strip() for x in data if str(x).strip()]
    return []


def generate_plain_key() -> str:
    return "sk-" + secrets.token_urlsafe(24)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(_SALT_LEN)
    dk = hashlib.pbkdf2_hmac(
        _PBKDF2_ALGO,
        password.encode("utf-8"),
        salt,
        _PBKDF2_ITERATIONS,
    )
    return f"pbkdf2:{_PBKDF2_ALGO}:{_PBKDF2_ITERATIONS}:{salt.hex()}:{dk.hex()}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        parts = password_hash.split(":")
        if len(parts) != 5 or parts[0] != "pbkdf2":
            return False
        algo = parts[1]
        iterations = int(parts[2])
        salt = bytes.fromhex(parts[3])
        stored_dk = parts[4]
        dk = hashlib.pbkdf2_hmac(
            algo,
            password.encode("utf-8"),
            salt,
            iterations,
        )
        return secrets.compare_digest(dk.hex(), stored_dk)
    except (ValueError, IndexError):
        return False


async def init_db() -> None:
    async with aiosqlite.connect(settings.db_file) as db:
        await db.executescript(SCHEMA)
        await _migrate_db(db)
        await db.commit()


async def _migrate_db(db) -> None:
    """处理存量数据库的字段补齐。"""
    async with db.execute("PRAGMA table_info(admin_users)") as cur:
        cols = [row[1] for row in await cur.fetchall()]
    if "role" not in cols:
        await db.execute(
            "ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'"
        )

    async with db.execute("PRAGMA table_info(api_keys)") as cur:
        cols = [row[1] for row in await cur.fetchall()]
    if "upstream_id" not in cols:
        await db.execute(
            "ALTER TABLE api_keys ADD COLUMN upstream_id INTEGER"
        )
    if "key" not in cols:
        await db.execute(
            "ALTER TABLE api_keys ADD COLUMN key TEXT"
        )

    async with db.execute("PRAGMA table_info(upstreams)") as cur:
        cols = [row[1] for row in await cur.fetchall()]
    if "protocol" not in cols:
        await db.execute(
            "ALTER TABLE upstreams ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai'"
        )
    if "models" not in cols:
        await db.execute(
            "ALTER TABLE upstreams ADD COLUMN models TEXT NOT NULL DEFAULT '[]'"
        )
    if "inject_include_usage" not in cols:
        await db.execute(
            "ALTER TABLE upstreams ADD COLUMN inject_include_usage INTEGER NOT NULL DEFAULT 0"
        )

    async with db.execute("PRAGMA table_info(usage_logs)") as cur:
        cols = [row[1] for row in await cur.fetchall()]
    if "input_tokens" not in cols:
        await db.execute(
            "ALTER TABLE usage_logs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0"
        )
    if "output_tokens" not in cols:
        await db.execute(
            "ALTER TABLE usage_logs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0"
        )
    if "cache_read_tokens" not in cols:
        await db.execute(
            "ALTER TABLE usage_logs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0"
        )

    await _ensure_default_upstream(db)


async def _ensure_default_upstream(db) -> None:
    """确保存在至少一个默认上游，存量迁移时从 settings 读取。"""
    cur = await db.execute("SELECT COUNT(*) FROM upstreams")
    row = await cur.fetchone()
    if row and row[0] > 0:
        return
    now = _now()
    base_url = settings.vllm_target_url.rstrip("/")
    api_key = settings.upstream_api_key or ""
    await db.execute(
        """INSERT INTO upstreams (name, base_url, api_key, is_default, created_at)
           VALUES (?, ?, ?, 1, ?)""",
        ("默认上游", base_url, api_key, now),
    )


async def create_key(name: Optional[str], expires_at: Optional[str], upstream_id: Optional[int] = None) -> dict:
    plain = generate_plain_key()
    row = {
        "key_hash": _hash_key(plain),
        "key": plain,
        "key_prefix": _prefix_of(plain),
        "name": name,
        "status": "active",
        "upstream_id": upstream_id,
        "created_at": _now(),
        "expires_at": expires_at,
    }
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute(
            """INSERT INTO api_keys
               (key_hash, key, key_prefix, name, status, upstream_id, created_at, expires_at)
               VALUES (:key_hash, :key, :key_prefix, :name, :status, :upstream_id, :created_at, :expires_at)""",
            row,
        )
        await db.commit()
        row_id = cur.lastrowid
    return {
        "id": row_id,
        "key": plain,
        "name": name,
        "status": "active",
        "upstream_id": upstream_id,
        "created_at": row["created_at"],
        "expires_at": expires_at,
    }


async def get_key_by_hash(key_hash: str) -> Optional[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, key_prefix, name, status, upstream_id, created_at, expires_at, "
            "last_used_at, request_count FROM api_keys WHERE key_hash = ?",
            (key_hash,),
        )
        r = await cur.fetchone()
        return dict(r) if r else None


async def list_keys() -> list[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, key_prefix, name, status, upstream_id, created_at, expires_at, "
            "last_used_at, request_count FROM api_keys ORDER BY id DESC"
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


async def get_key(key_id: int) -> Optional[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, key_prefix, name, status, upstream_id, created_at, expires_at, "
            "last_used_at, request_count FROM api_keys WHERE id = ?",
            (key_id,),
        )
        r = await cur.fetchone()
        return dict(r) if r else None


async def get_key_full(key_id: int) -> Optional[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, key, key_prefix, name, status, upstream_id FROM api_keys WHERE id = ?",
            (key_id,),
        )
        r = await cur.fetchone()
        return dict(r) if r else None


async def revoke_key(key_id: int) -> bool:
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute(
            "UPDATE api_keys SET status = 'revoked' WHERE id = ? AND status = 'active'",
            (key_id,),
        )
        await db.commit()
        return cur.rowcount > 0


async def reset_key(key_id: int) -> Optional[dict]:
    """重置密钥：生成一把新明文替换 key/key_hash/key_prefix，原 key 立即失效。

    保留该密钥的 id/name/upstream/统计/过期时间（视为同一把钥匙换锁芯）。
    返回含新明文 key 的记录（仅此一次），供后台回显；密钥不存在或非 active 时返回 None。
    旧的 key_hash 被覆盖后网关即无法再放行旧明文，因此已泄露的密钥也能通过重置止血。
    """
    plain = generate_plain_key()
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "UPDATE api_keys SET key_hash = ?, key = ?, key_prefix = ? "
            "WHERE id = ? AND status = 'active'",
            (_hash_key(plain), plain, _prefix_of(plain), key_id),
        )
        if cur.rowcount == 0:
            return None
        cur = await db.execute(
            "SELECT id, key, key_prefix, name, status, upstream_id, created_at, expires_at "
            "FROM api_keys WHERE id = ?",
            (key_id,),
        )
        r = await cur.fetchone()
        await db.commit()
        return dict(r) if r else None


async def record_usage(key_id: int) -> int:
    """记录一次调用并返回 usage_logs 行 id（供响应结束后回填 token 用量）。"""
    now = _now()
    date_str = now[:10]
    async with aiosqlite.connect(settings.db_file) as db:
        await db.execute(
            "UPDATE api_keys SET last_used_at = ?, request_count = request_count + 1 "
            "WHERE id = ?",
            (now, key_id),
        )
        cur = await db.execute(
            "SELECT key_prefix, name FROM api_keys WHERE id = ?",
            (key_id,),
        )
        row = await cur.fetchone()
        log_id = None
        if row:
            cur = await db.execute(
                """INSERT INTO usage_logs
                   (key_id, key_prefix, key_name, request_time, date_str)
                   VALUES (?, ?, ?, ?, ?)""",
                (key_id, row[0], row[1], now, date_str),
            )
            log_id = cur.lastrowid
        await db.commit()
        return log_id


async def update_usage_log(log_id: int, input_tokens: int, output_tokens: int, cache_read_tokens=None) -> None:
    """回填一次调用实际消耗的 token；调用方仅在拿到上游 usage 时调用。

    input_tokens/output_tokens 为 None 表示上游未上报（保持 0 不覆盖），
    因此这里强制要求给出整数，由调用方决定是否需要回填。
    cache_read_tokens 为本次输入中命中上游缓存的 token 数（无上报记 0）。
    """
    if not log_id:
        return
    async with aiosqlite.connect(settings.db_file) as db:
        await db.execute(
            "UPDATE usage_logs SET input_tokens = ?, output_tokens = ?, "
            "cache_read_tokens = ? WHERE id = ?",
            (
                int(input_tokens or 0),
                int(output_tokens or 0),
                int(cache_read_tokens or 0),
                log_id,
            ),
        )
        await db.commit()


async def create_admin_user(username: str, password: str, role: str = "viewer") -> int:
    pwd_hash = hash_password(password)
    now = _now()
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute(
            """INSERT INTO admin_users (username, password_hash, role, created_at)
               VALUES (?, ?, ?, ?)""",
            (username, pwd_hash, role, now),
        )
        await db.commit()
        return cur.lastrowid


async def get_admin_by_username(username: str) -> Optional[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT * FROM admin_users WHERE username = ?", (username,)
        )
        r = await cur.fetchone()
        return dict(r) if r else None


async def update_admin_last_login(user_id: int) -> None:
    async with aiosqlite.connect(settings.db_file) as db:
        await db.execute(
            "UPDATE admin_users SET last_login_at = ? WHERE id = ?",
            (_now(), user_id),
        )
        await db.commit()


async def count_admin_users() -> int:
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute("SELECT COUNT(*) FROM admin_users")
        row = await cur.fetchone()
        return row[0] if row else 0


async def init_default_admin() -> bool:
    count = await count_admin_users()
    if count > 0:
        return False
    username = settings.default_admin_username or "admin"
    password = settings.default_admin_password or "hrgk@admin"
    await create_admin_user(username, password, role="admin")
    return True


async def list_admin_users() -> list[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, username, role, created_at, last_login_at "
            "FROM admin_users ORDER BY id ASC"
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


async def get_admin_by_id(user_id: int) -> Optional[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, username, role, created_at, last_login_at "
            "FROM admin_users WHERE id = ?",
            (user_id,),
        )
        r = await cur.fetchone()
        return dict(r) if r else None


async def update_admin_role(user_id: int, role: str) -> bool:
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute(
            "UPDATE admin_users SET role = ? WHERE id = ?",
            (role, user_id),
        )
        await db.commit()
        return cur.rowcount > 0


async def update_admin_password(user_id: int, password: str) -> bool:
    pwd_hash = hash_password(password)
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute(
            "UPDATE admin_users SET password_hash = ? WHERE id = ?",
            (pwd_hash, user_id),
        )
        await db.commit()
        return cur.rowcount > 0


async def delete_admin_user(user_id: int) -> bool:
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute("DELETE FROM admin_users WHERE id = ?", (user_id,))
        await db.commit()
        return cur.rowcount > 0


async def count_admin_by_role(role: str) -> int:
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute(
            "SELECT COUNT(*) FROM admin_users WHERE role = ?", (role,)
        )
        row = await cur.fetchone()
        return row[0] if row else 0


# ---------- 用量聚合（支持 day / week / month 三种时间粒度） ----------
#
# 统一做法：SQL 只按自然日（date_str）做第一层聚合，week/month 的桶化在
# Python 侧完成（ISO 周=周一起始、自然月=每月 1 号起），避免 SQLite 周/月
# 边界语义与 Python/JS 不一致。窗口内没有记录的桶补 0，保证趋势/矩阵连续。


def _utc_today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _d_from(date_str: str):
    return datetime.strptime(date_str[:10], "%Y-%m-%d").date()


def _bucket_start(day, granularity: str):
    """day 所在桶的起始日期：day→当天；week→周一；month→1 号。"""
    if granularity == "week":
        return day - timedelta(days=day.weekday())
    if granularity == "month":
        return day.replace(day=1)
    return day


def _next_bucket_start(bucket_start, granularity: str):
    """桶起始日的下一个桶起始日。"""
    if granularity == "week":
        return bucket_start + timedelta(days=7)
    if granularity == "month":
        y = bucket_start.year + (1 if bucket_start.month == 12 else 0)
        m = 1 if bucket_start.month == 12 else bucket_start.month + 1
        return bucket_start.replace(year=y, month=m)
    return bucket_start + timedelta(days=1)


def _bucket_label(bucket_start, granularity: str) -> str:
    if granularity == "month":
        return bucket_start.strftime("%Y-%m")
    if granularity == "week":
        return bucket_start.strftime("%m-%d") + "周"
    return bucket_start.strftime("%m-%d")


def _period_series(start_day, end_day, granularity: str) -> list[dict]:
    """生成窗口内连续的周期序列，每项 {start,end,label}（start/end 为 YYYY-MM-DD）。

    end 不超过窗口末日（末个周期未走完时只标到今日）。
    """
    bucket = _bucket_start(start_day, granularity)
    out: list[dict] = []
    guard = 0
    while bucket <= end_day and guard < 1000:
        guard += 1
        nxt = _next_bucket_start(bucket, granularity)
        period_end = nxt - timedelta(days=1)
        if period_end > end_day:
            period_end = end_day
        out.append({
            "start": bucket.isoformat(),
            "end": period_end.isoformat(),
            "label": _bucket_label(bucket, granularity),
        })
        bucket = nxt
    return out


async def _fetch_daily_aggregates(start_date: str) -> list[dict]:
    """拉取窗口内按自然日聚合的原始计数与 token，供上层桶化复用。"""
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """SELECT date_str, COUNT(*) AS cnt,
                      COALESCE(SUM(input_tokens), 0) AS itok,
                      COALESCE(SUM(output_tokens), 0) AS otok,
                      COALESCE(SUM(cache_read_tokens), 0) AS ctok
               FROM usage_logs
               WHERE date_str >= ?
               GROUP BY date_str""",
            (start_date,),
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


async def get_usage_trend(days: int = 7, granularity: str = "day") -> list[dict]:
    """按粒度返回趋势序列（补零到完整周期）。"""
    if granularity not in GRANULARITIES:
        granularity = "day"
    end_day = _d_from(_utc_today())
    start_day = end_day - timedelta(days=days - 1)
    daily = await _fetch_daily_aggregates(start_day.isoformat())

    # 逐日聚合 → 桶聚合
    bucket_agg: dict[str, list[int]] = {}
    for row in daily:
        key = _bucket_start(_d_from(row["date_str"]), granularity).isoformat()
        agg = bucket_agg.setdefault(key, [0, 0, 0, 0])
        agg[0] += row["cnt"]
        agg[1] += row["itok"]
        agg[2] += row["otok"]
        agg[3] += row["ctok"]

    out = []
    for period in _period_series(start_day, end_day, granularity):
        cnt, itok, otok, ctok = bucket_agg.get(period["start"], [0, 0, 0, 0])
        out.append({
            "date": period["start"],
            "start": period["start"],
            "end": period["end"],
            "label": period["label"],
            "count": cnt,
            "input_tokens": itok,
            "output_tokens": otok,
            "cache_read_tokens": ctok,
        })
    return out


async def get_usage_by_key(
    days: int = 30, granularity: str = "day", limit: int = 10
) -> list[dict]:
    """窗口内按密钥聚合的用量排行（含 token 汇总）。"""
    if granularity not in GRANULARITIES:
        granularity = "day"
    end_day = _d_from(_utc_today())
    start_day = end_day - timedelta(days=days - 1)
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """SELECT l.key_id, k.key_prefix AS key_prefix,
                      k.name AS key_name, COUNT(*) AS call_count,
                      COALESCE(SUM(l.input_tokens), 0) AS input_tokens,
                      COALESCE(SUM(l.output_tokens), 0) AS output_tokens,
                      COALESCE(SUM(l.cache_read_tokens), 0) AS cache_read_tokens
               FROM usage_logs l
               LEFT JOIN api_keys k ON k.id = l.key_id
               WHERE l.date_str >= ?
               GROUP BY l.key_id
               ORDER BY call_count DESC
               LIMIT ?""",
            (start_day.isoformat(), limit),
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


async def get_usage_matrix(days: int = 7, granularity: str = "day") -> dict:
    """密钥 × 周期 的每日/每周/每月用量矩阵。

    返回结构：{granularity, days, periods: [{start,end,label}...],
    rows: [{key_id, key_prefix, key_name, total_calls, input_tokens, output_tokens,
            cache_read_tokens, cells: [{count, input_tokens, output_tokens,
            cache_read_tokens}...]}...]}
    cells 与 periods 一一对应（无调用记 0）。
    """
    if granularity not in GRANULARITIES:
        granularity = "day"
    end_day = _d_from(_utc_today())
    start_day = end_day - timedelta(days=days - 1)
    periods = _period_series(start_day, end_day, granularity)
    period_keys = [p["start"] for p in periods]

    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """SELECT l.key_id, l.key_prefix, l.key_name, l.date_str,
                      COUNT(*) AS cnt,
                      COALESCE(SUM(l.input_tokens), 0) AS itok,
                      COALESCE(SUM(l.output_tokens), 0) AS otok,
                      COALESCE(SUM(l.cache_read_tokens), 0) AS ctok
               FROM usage_logs l
               WHERE l.date_str >= ?
               GROUP BY l.key_id, l.date_str
               ORDER BY l.key_id ASC, l.date_str ASC""",
            (start_day.isoformat(),),
        )
        rows = await cur.fetchall()

    # (key_id, 桶起始日) → 聚合
    cell_map: dict[int, dict[str, tuple[int, int, int, int]]] = {}
    totals: dict[int, tuple[int, int, int, int]] = {}  # key_id → (calls, in, out, cache_read)
    for r in rows:
        kid = r["key_id"]
        bkey = _bucket_start(_d_from(r["date_str"]), granularity).isoformat()
        cell_map.setdefault(kid, {})[bkey] = (r["cnt"], r["itok"], r["otok"], r["ctok"])
        cur_tot = totals.get(kid, (0, 0, 0, 0))
        totals[kid] = (
            cur_tot[0] + r["cnt"],
            cur_tot[1] + r["itok"],
            cur_tot[2] + r["otok"],
            cur_tot[3] + r["ctok"],
        )

    key_meta: dict[int, tuple[str, str]] = {}
    for r in rows:
        key_meta.setdefault(r["key_id"], (r["key_prefix"], r["key_name"]))

    out_rows = []
    for kid, (prefix, name) in key_meta.items():
        tc, ti, to, tcache = totals.get(kid, (0, 0, 0, 0))
        cells = []
        for pk in period_keys:
            cnt, itok, otok, ctok = cell_map.get(kid, {}).get(pk, (0, 0, 0, 0))
            cells.append({
                "count": cnt,
                "input_tokens": itok,
                "output_tokens": otok,
                "cache_read_tokens": ctok,
            })
        out_rows.append({
            "key_id": kid,
            "key_prefix": prefix,
            "key_name": name,
            "total_calls": tc,
            "input_tokens": ti,
            "output_tokens": to,
            "cache_read_tokens": tcache,
            "cells": cells,
        })

    # 用量视角：先按总 token 降序，token 相同时按调用次数降序
    out_rows.sort(
        key=lambda x: (x["input_tokens"] + x["output_tokens"], x["total_calls"]),
        reverse=True,
    )
    return {
        "granularity": granularity,
        "days": days,
        "periods": periods,
        "rows": out_rows,
    }


async def get_overall_stats() -> dict:
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute("SELECT COUNT(*) FROM api_keys")
        total_keys = (await cur.fetchone())[0]
        cur = await db.execute(
            "SELECT COUNT(*) FROM api_keys WHERE status = 'active'"
        )
        active_keys = (await cur.fetchone())[0]
        cur = await db.execute("SELECT COUNT(*) FROM admin_users")
        total_users = (await cur.fetchone())[0]
        cur = await db.execute(
            "SELECT COALESCE(SUM(request_count), 0) FROM api_keys"
        )
        total_calls = (await cur.fetchone())[0]
        cur = await db.execute("SELECT COUNT(*) FROM usage_logs WHERE date_str = date('now')")
        today_calls = (await cur.fetchone())[0]
        cur = await db.execute(
            "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM usage_logs"
        )
        total_tokens = (await cur.fetchone())[0]
        cur = await db.execute(
            "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM usage_logs "
            "WHERE date_str = date('now')"
        )
        today_tokens = (await cur.fetchone())[0]
        cur = await db.execute(
            "SELECT COALESCE(SUM(cache_read_tokens), 0) FROM usage_logs"
        )
        total_cache_read = (await cur.fetchone())[0]
        cur = await db.execute(
            "SELECT COALESCE(SUM(cache_read_tokens), 0) FROM usage_logs "
            "WHERE date_str = date('now')"
        )
        today_cache_read = (await cur.fetchone())[0]
        return {
            "total_keys": total_keys,
            "active_keys": active_keys,
            "total_users": total_users,
            "total_calls": total_calls,
            "today_calls": today_calls,
            "total_tokens": total_tokens,
            "today_tokens": today_tokens,
            "total_cache_read_tokens": total_cache_read,
            "today_cache_read_tokens": today_cache_read,
        }


async def list_upstreams() -> list[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, name, base_url, api_key, protocol, models, is_default, "
            "inject_include_usage, created_at "
            "FROM upstreams ORDER BY is_default DESC, id ASC"
        )
        rows = await cur.fetchall()
        return [_upstream_row(r) for r in rows]


def _upstream_row(r) -> dict:
    """把上游行转 dict：models 存储文本解码为列表，inject_include_usage 转 bool。"""
    d = dict(r)
    d["models"] = _models_from_text(d.get("models"))
    d["inject_include_usage"] = bool(d.get("inject_include_usage"))
    return d


async def get_upstream(upstream_id: int) -> Optional[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, name, base_url, api_key, protocol, models, is_default, "
            "inject_include_usage, created_at "
            "FROM upstreams WHERE id = ?",
            (upstream_id,),
        )
        r = await cur.fetchone()
        return _upstream_row(r) if r else None


async def get_default_upstream() -> Optional[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, name, base_url, api_key, protocol, models, is_default, "
            "inject_include_usage, created_at "
            "FROM upstreams WHERE is_default = 1 LIMIT 1"
        )
        r = await cur.fetchone()
        return _upstream_row(r) if r else None


async def create_upstream(
    name: str,
    base_url: str,
    api_key: str = "",
    protocol: str = "openai",
    is_default: bool = False,
    models=None,
    inject_include_usage: bool = False,
) -> dict:
    protocol = protocol if protocol in ("openai", "anthropic") else "openai"
    models_text = _models_to_text(models)
    now = _now()
    async with aiosqlite.connect(settings.db_file) as db:
        if is_default:
            await db.execute("UPDATE upstreams SET is_default = 0")
        cur = await db.execute(
            """INSERT INTO upstreams (name, base_url, api_key, protocol, models, is_default,
                                      inject_include_usage, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (name, base_url.rstrip("/"), api_key, protocol, models_text,
             1 if is_default else 0, 1 if inject_include_usage else 0, now),
        )
        await db.commit()
        return {
            "id": cur.lastrowid,
            "name": name,
            "base_url": base_url.rstrip("/"),
            "api_key": api_key,
            "protocol": protocol,
            "models": _models_from_text(models_text),
            "is_default": is_default,
            "inject_include_usage": inject_include_usage,
            "created_at": now,
        }


async def update_upstream(
    upstream_id: int,
    name: str,
    base_url: str,
    api_key: str = "",
    protocol: str = "openai",
    is_default: bool = False,
    models=None,
    inject_include_usage: bool = False,
) -> bool:
    protocol = protocol if protocol in ("openai", "anthropic") else "openai"
    models_text = _models_to_text(models)
    async with aiosqlite.connect(settings.db_file) as db:
        if is_default:
            await db.execute("UPDATE upstreams SET is_default = 0 WHERE id != ?", (upstream_id,))
        cur = await db.execute(
            """UPDATE upstreams SET name = ?, base_url = ?, api_key = ?, protocol = ?,
                   models = ?, is_default = ?, inject_include_usage = ?
               WHERE id = ?""",
            (name, base_url.rstrip("/"), api_key, protocol, models_text,
             1 if is_default else 0, 1 if inject_include_usage else 0, upstream_id),
        )
        await db.commit()
        return cur.rowcount > 0


async def delete_upstream(upstream_id: int) -> bool:
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute("SELECT is_default FROM upstreams WHERE id = ?", (upstream_id,))
        row = await cur.fetchone()
        if not row:
            return False
        if row[0]:
            return False
        await db.execute(
            "UPDATE api_keys SET upstream_id = NULL WHERE upstream_id = ?",
            (upstream_id,),
        )
        cur = await db.execute("DELETE FROM upstreams WHERE id = ?", (upstream_id,))
        await db.commit()
        return cur.rowcount > 0


async def get_upstream_for_key(key_id: int) -> Optional[dict]:
    """根据 key_id 获取其上游配置，未绑定则返回默认上游。"""
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT upstream_id FROM api_keys WHERE id = ?",
            (key_id,),
        )
        row = await cur.fetchone()
        if not row:
            return None
        upstream_id = row[0]
        if upstream_id:
            cur = await db.execute(
                "SELECT id, name, base_url, api_key, protocol, models, is_default, "
                "inject_include_usage FROM upstreams WHERE id = ?",
                (upstream_id,),
            )
            r = await cur.fetchone()
            if r:
                return _upstream_row(r)
        cur = await db.execute(
            "SELECT id, name, base_url, api_key, protocol, models, is_default, "
            "inject_include_usage FROM upstreams WHERE is_default = 1 LIMIT 1"
        )
        r = await cur.fetchone()
        return _upstream_row(r) if r else None


async def update_key_upstream(key_id: int, upstream_id: Optional[int]) -> bool:
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute(
            "UPDATE api_keys SET upstream_id = ? WHERE id = ?",
            (upstream_id, key_id),
        )
        await db.commit()
        return cur.rowcount > 0


async def rename_key(key_id: int, name: Optional[str]) -> bool:
    """仅修改密钥备注名称，不影响 key 明文、绑定上游与统计。"""
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute(
            "UPDATE api_keys SET name = ? WHERE id = ?",
            (name, key_id),
        )
        await db.commit()
        return cur.rowcount > 0
