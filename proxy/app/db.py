"""SQLite 数据访问层：API-key 的持久化与 CRUD。

安全策略：仅存储 key 的 sha256 哈希与可展示前缀，明文 key 不落库。
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone
from typing import Optional

import aiosqlite

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT UNIQUE NOT NULL,
    key_prefix TEXT NOT NULL,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    request_count INTEGER NOT NULL DEFAULT 0
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_key(plain: str) -> str:
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()


def _prefix_of(plain: str) -> str:
    # 形如 sk-ab12****
    head = plain[:8]
    return f"{head}{'*' * 4}"


def generate_plain_key() -> str:
    return "sk-" + secrets.token_urlsafe(24)


async def init_db() -> None:
    async with aiosqlite.connect(settings.db_file) as db:
        await db.execute(SCHEMA)
        await db.commit()


async def create_key(name: Optional[str], expires_at: Optional[str]) -> dict:
    """创建一条密钥，返回包含明文 key 的记录（明文仅此一次返回）。"""
    plain = generate_plain_key()
    row = {
        "key_hash": _hash_key(plain),
        "key_prefix": _prefix_of(plain),
        "name": name,
        "status": "active",
        "created_at": _now(),
        "expires_at": expires_at,
    }
    async with aiosqlite.connect(settings.db_file) as db:
        cur = await db.execute(
            """INSERT INTO api_keys
               (key_hash, key_prefix, name, status, created_at, expires_at)
               VALUES (:key_hash, :key_prefix, :name, :status, :created_at, :expires_at)""",
            row,
        )
        await db.commit()
        row_id = cur.lastrowid
    return {
        "id": row_id,
        "key": plain,  # 明文仅返回一次
        "name": name,
        "status": "active",
        "created_at": row["created_at"],
        "expires_at": expires_at,
    }


async def get_key_by_hash(key_hash: str) -> Optional[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT * FROM api_keys WHERE key_hash = ?", (key_hash,)
        )
        r = await cur.fetchone()
        return dict(r) if r else None


async def list_keys() -> list[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, key_prefix, name, status, created_at, expires_at, "
            "last_used_at, request_count FROM api_keys ORDER BY id DESC"
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


async def get_key(key_id: int) -> Optional[dict]:
    async with aiosqlite.connect(settings.db_file) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, key_prefix, name, status, created_at, expires_at, "
            "last_used_at, request_count FROM api_keys WHERE id = ?",
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


async def record_usage(key_id: int) -> None:
    async with aiosqlite.connect(settings.db_file) as db:
        await db.execute(
            "UPDATE api_keys SET last_used_at = ?, request_count = request_count + 1 "
            "WHERE id = ?",
            (_now(), key_id),
        )
        await db.commit()
