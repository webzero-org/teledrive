from fastapi import APIRouter, HTTPException
from db import get_db
from telegram_client import get_client

router = APIRouter(prefix="/api/channels", tags=["channels"])


@router.get("")
async def list_channels():
    db = get_db()
    channels = await db.channels.find().sort("title", 1).to_list(length=500)
    for ch in channels:
        ch["id"] = str(ch.pop("_id"))
    return {"channels": channels}


@router.post("")
async def create_channel(title: str, description: str = ""):
    app = await get_client()

    # Pyrogram: create_channel returns the Chat object directly
    chat = await app.create_channel(title=title, description=description)
    channel_id = chat.id

    db = get_db()
    doc = {
        "channel_id": channel_id,
        "title": title,
        "description": description,
    }
    await db.channels.update_one(
        {"channel_id": channel_id}, {"$set": doc}, upsert=True
    )
    return {"channel_id": channel_id, "title": title}
