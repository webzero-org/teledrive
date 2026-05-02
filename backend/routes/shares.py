import secrets
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timedelta

from db import get_db

router = APIRouter(prefix="/api/shares", tags=["shares"])


class CreateShareRequest(BaseModel):
    channel_id: int
    path: Optional[str] = None        # None = share entire channel
    expires_in_days: Optional[int] = None
    label: Optional[str] = None


@router.post("")
async def create_share(req: CreateShareRequest):
    db = get_db()
    token = secrets.token_urlsafe(16)
    doc = {
        "token": token,
        "channel_id": req.channel_id,
        "path": req.path,
        "label": req.label or "",
        "created_at": datetime.utcnow(),
        "expires_at": (
            datetime.utcnow() + timedelta(days=req.expires_in_days)
            if req.expires_in_days
            else None
        ),
    }
    await db.shares.insert_one(doc)
    return {"token": token}


@router.get("/{token}")
async def resolve_share(token: str):
    """Called by the public viewer — no login needed."""
    db = get_db()
    share = await db.shares.find_one({"token": token})
    if not share:
        raise HTTPException(404, "Share link not found")

    if share.get("expires_at") and share["expires_at"] < datetime.utcnow():
        raise HTTPException(410, "Share link has expired")

    channel = await db.channels.find_one({"channel_id": share["channel_id"]})

    return {
        "token": token,
        "channel_id": share["channel_id"],
        "channel_title": channel["title"] if channel else str(share["channel_id"]),
        "path": share.get("path"),
        "label": share.get("label"),
    }


@router.delete("/{token}")
async def delete_share(token: str):
    db = get_db()
    result = await db.shares.delete_one({"token": token})
    if result.deleted_count == 0:
        raise HTTPException(404, "Share not found")
    return {"ok": True}


@router.get("")
async def list_shares():
    db = get_db()
    shares = await db.shares.find().sort("created_at", -1).to_list(length=200)
    for s in shares:
        s["id"] = str(s.pop("_id"))
        if s.get("created_at"):
            s["created_at"] = s["created_at"].isoformat()
        if s.get("expires_at"):
            s["expires_at"] = s["expires_at"].isoformat()
    return {"shares": shares}
