"""管理路由：API-key 的发放 / 列表 / 查询 / 吊销。全部由 MASTER_KEY 保护。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from . import db
from .auth import verify_master_key
from .schemas import KeyCreateRequest, KeyCreatedResponse, KeyListItem, Message

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(verify_master_key)])


@router.post("/keys", response_model=KeyCreatedResponse)
async def create_key(body: KeyCreateRequest) -> dict:
    record = await db.create_key(body.name, body.expires_at)
    return record


@router.get("/keys", response_model=list[KeyListItem])
async def list_keys() -> list[dict]:
    return await db.list_keys()


@router.get("/keys/{key_id}", response_model=KeyListItem)
async def get_key(key_id: int) -> dict:
    record = await db.get_key(key_id)
    if record is None:
        raise HTTPException(status_code=404, detail="密钥不存在")
    return record


@router.delete("/keys/{key_id}", response_model=Message)
async def revoke_key(key_id: int) -> dict:
    ok = await db.revoke_key(key_id)
    if not ok:
        raise HTTPException(status_code=404, detail="密钥不存在或已吊销")
    return {"message": "已吊销"}
