"""
/api/sync  —  scan a Telegram channel's message history and rebuild the
              MongoDB 'files' and 'thumbnails' collections from captions.

Run this if you lose the DB, or after a bulk upload.
"""
import asyncio
from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from db import get_db
from pyrogram.types import Message
from telegram_client import get_client, parse_caption, path_to_parts

router = APIRouter(prefix="/api/sync", tags=["sync"])

_sync_status: dict = {}   # channel_id → progress dict


class SyncRequest(BaseModel):
    channel_id: int


@router.post("")
async def start_sync(req: SyncRequest, bg: BackgroundTasks):
    if _sync_status.get(req.channel_id, {}).get("running"):
        raise HTTPException(409, "Sync already running for this channel")
    bg.add_task(_run_sync, req.channel_id)
    return {"ok": True, "message": "Sync started in background"}


@router.get("/status/{channel_id}")
async def sync_status(channel_id: int):
    return _sync_status.get(channel_id, {"running": False, "processed": 0})


async def _run_sync(channel_id: int):
    _sync_status[channel_id] = {"running": True, "processed": 0, "errors": 0}
    db = get_db()
    app = await get_client()
    client = app

    processed = 0
    errors = 0
    message: Message = None

    try:
        async for message in client.get_chat_history(channel_id):
            if not message.document or not message.caption:
                continue
            
            parsed = parse_caption(message.caption)
            if not parsed:
                continue

            try:
                if parsed["kind"] == "thumbnail":
                    await db.thumbnails.update_one(
                        {"message_id": message.id},
                        {"$set": {
                            "message_id": message.id,
                            "channel_id": channel_id,
                            "original_message_id": parsed.get("original_message_id"),
                            "file_id": str(message.document.file_id),
                        }},
                        upsert=True,
                    )

                elif parsed["kind"] in ("file", "file_part"):
                    folder_path, name, _ = path_to_parts(parsed["path"])
                    is_part = parsed["kind"] == "file_part"

                    base_doc = {
                        "message_id": message.id,
                        "channel_id": channel_id,
                        "file_id": str(message.document.file_id),
                        "type": parsed["type"],
                        "path": parsed["path"],
                        "folder_path": folder_path,
                        "name": name,
                        "resolution": parsed.get("resolution", "-"),
                        "thumb_msg_id": parsed.get("thumb_msg_id"),
                        "size": message.document.file_size,
                        "mime_type": message.document.mime_type or "",
                        "date": message.date.isoformat() if message.date else None,
                        "is_split": is_part,
                    }

                    if is_part:
                        base_doc["part_num"] = parsed.get("part_num")
                        base_doc["total_parts"] = parsed.get("total_parts")
                        base_doc["group_id"] = parsed.get("group_id")

                        # Only the first part is the "primary" record in files;
                        # all parts also go into file_parts collection.
                        await db.file_parts.update_one(
                            {"message_id": message.id},
                            {"$set": base_doc},
                            upsert=True,
                        )

                        # Upsert the group's primary record (part 1)
                        if parsed.get("part_num") == 1:
                            await db.files.update_one(
                                {"group_id": parsed.get("group_id")},
                                {"$set": base_doc},
                                upsert=True,
                            )
                    else:
                        await db.files.update_one(
                            {"message_id": message.id},
                            {"$set": base_doc},
                            upsert=True,
                        )

                processed += 1
            except Exception as e:
                print(f"Error processing message {message.id} in channel {channel_id}", e)
                errors += 1

            _sync_status[channel_id]["processed"] = processed
            _sync_status[channel_id]["errors"] = errors

            # yield control every 50 messages so FastAPI stays responsive
            if processed % 50 == 0:
                await asyncio.sleep(0)

    finally:
        _sync_status[channel_id]["running"] = False
        _sync_status[channel_id]["processed"] = processed
        _sync_status[channel_id]["errors"] = errors
