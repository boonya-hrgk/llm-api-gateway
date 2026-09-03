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
from datetime import datetime, timezone
from typing import Optional

import aiosqlite

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS upstreams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT DEFAULT '',
    protocol TEXT NOT NULL DEFAULT 'openai',
    models TEXT NOT NULL DEFAULT '[]',
    is_default INTEGER NOT NULL DEFAULT 0,
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
    date_str TEXT NOT NULL
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


async def record_usage(key_id: int) -> None:
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
        if row:
            await db.execute(
                """INSERT INTO usage_logs
                   (key_id, key_prefix, key_name, request_time, date_str)
                   VALUES (?, ?, ?, ?, ?)""",
                (key_id, row[0], row[1], now, date_str),
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


async def get_usage_trend(days: int = 7) -> list[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """SELECT date_str AS date, COUNT(*) AS count
               FROM usage_logs
               WHERE date_str >= date('now', ?)
               GROUP BY date_str
               ORDER BY date_str ASC""",
            (f"-{days - 1} days",),
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


async def get_usage_by_key(limit: int = 10) -> list[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """SELECT l.key_id, k.key_prefix AS key_prefix,
                      k.name AS key_name, COUNT(*) AS call_count
               FROM usage_logs l
               LEFT JOIN api_keys k ON k.id = l.key_id
               GROUP BY l.key_id
               ORDER BY call_count DESC
               LIMIT ?""",
            (limit,),
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


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
        return {
            "total_keys": total_keys,
            "active_keys": active_keys,
            "total_users": total_users,
            "total_calls": total_calls,
            "today_calls": today_calls,
        }


async def list_upstreams() -> list[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, name, base_url, api_key, protocol, models, is_default, created_at "
            "FROM upstreams ORDER BY is_default DESC, id ASC"
        )
        rows = await cur.fetchall()
        return [_upstream_row(r) for r in rows]


def _upstream_row(r) -> dict:
    """把上游行转 dict，并把 models 存储文本解码为列表。"""
    d = dict(r)
    d["models"] = _models_from_text(d.get("models"))
    return d


async def get_upstream(upstream_id: int) -> Optional[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, name, base_url, api_key, protocol, models, is_default, created_at "
            "FROM upstreams WHERE id = ?",
            (upstream_id,),
        )
        r = await cur.fetchone()
        return _upstream_row(r) if r else None


async def get_default_upstream() -> Optional[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, name, base_url, api_key, protocol, models, is_default, created_at "
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
) -> dict:
    protocol = protocol if protocol in ("openai", "anthropic") else "openai"
    models_text = _models_to_text(models)
    now = _now()
    async with aiosqlite.connect(settings.db_file) as db:
        if is_default:
            await db.execute("UPDATE upstreams SET is_default = 0")
        cur = await db.execute(
            """INSERT INTO upstreams (name, base_url, api_key, protocol, models, is_default, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (name, base_url.rstrip("/"), api_key, protocol, models_text, 1 if is_default else 0, now),
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
) -> bool:
    protocol = protocol if protocol in ("openai", "anthropic") else "openai"
    models_text = _models_to_text(models)
    async with aiosqlite.connect(settings.db_file) as db:
        if is_default:
            await db.execute("UPDATE upstreams SET is_default = 0 WHERE id != ?", (upstream_id,))
        cur = await db.execute(
            """UPDATE upstreams SET name = ?, base_url = ?, api_key = ?, protocol = ?,
                   models = ?, is_default = ?
               WHERE id = ?""",
            (name, base_url.rstrip("/"), api_key, protocol, models_text, 1 if is_default else 0, upstream_id),
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
                "SELECT id, name, base_url, api_key, protocol, models, is_default FROM upstreams WHERE id = ?",
                (upstream_id,),
            )
            r = await cur.fetchone()
            if r:
                return _upstream_row(r)
        cur = await db.execute(
            "SELECT id, name, base_url, api_key, protocol, models, is_default FROM upstreams WHERE is_default = 1 LIMIT 1"
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
