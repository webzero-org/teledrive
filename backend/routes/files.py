import re
import struct
import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from db import get_db
from telegram_client import get_client

router = APIRouter(prefix="/api/files", tags=["files"])

LOCAL_HEADER_SIG = b'PK\x03\x04'
ZIP_CHUNK = 512 * 1024   # 512 KB per read


def _serialize(doc) -> dict:
    doc["id"] = str(doc.pop("_id"))
    return doc


# ── List / folder endpoints ───────────────────────────────────────────────────

@router.get("")
async def list_files(
    channel_id: int,
    path: Optional[str] = None,
    type: Optional[str] = None,
    recursive: bool = False,
    skip: int = 0,
    limit: int = 100,
):
    db = get_db()
    query: dict = {"channel_id": channel_id}
    if type:
        query["type"] = type
    if path is not None:
        query["folder_path"] = (
            {"$regex": f"^{re.escape(path)}"} if recursive else path
        )
    cursor = db.files.find(query).skip(skip).limit(limit).sort("name", 1)
    docs = await cursor.to_list(length=limit)
    total = await db.files.count_documents(query)
    return {"total": total, "items": [_serialize(d) for d in docs]}


@router.get("/folders")
async def list_folders(channel_id: int):
    db = get_db()
    paths = await db.files.distinct("folder_path", {"channel_id": channel_id})
    return {"folders": sorted(p for p in paths if p is not None)}


# ── Thumbnail ─────────────────────────────────────────────────────────────────

@router.get("/{message_id}/thumbnail")
async def get_thumbnail(message_id: int, channel_id: int):
    db = get_db()
    file_doc = await db.files.find_one(
        {"message_id": message_id, "channel_id": channel_id}
    )
    if not file_doc:
        raise HTTPException(404, "File not found")
    thumb_msg_id = file_doc.get("thumb_msg_id")
    if not thumb_msg_id:
        raise HTTPException(404, "No thumbnail")

    app = await get_client()
    msg = await app.get_messages(channel_id, thumb_msg_id)
    if not msg or not msg.document:
        raise HTTPException(404, "Thumbnail not found on Telegram")

    async def stream():
        async for chunk in app.stream_media(msg, limit=msg.document.file_size):
            yield chunk

    return StreamingResponse(
        stream(), media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ── Download (single file or server-side-merged split file) ───────────────────

@router.get("/{message_id}/download")
async def download_file(message_id: int, channel_id: int, inline: bool = False):
    """
    Single files → proxy-stream directly from Telegram.

    Split files  → fetch each ZIP_STORED part from Telegram in sequence,
                   strip the local file header (30 + fname_len + extra_len bytes),
                   and stream the raw data bytes concatenated.
                   The client receives one clean, complete file.

                   ZIP_STORED has zero compression — the bytes inside the zip
                   are identical to the original file bytes, so we just skip
                   the wrapper and pipe them straight through.
    """
    db = get_db()
    file_doc = await db.files.find_one(
        {"message_id": message_id, "channel_id": channel_id}
    )
    if not file_doc:
        raise HTTPException(404, "File not found")

    app = await get_client()
    filename = file_doc.get("name", f"file_{message_id}")
    disposition = "inline" if inline else f'attachment; filename="{filename}"'

    # ── Non-split file ────────────────────────────────────────────────────────
    if not file_doc.get("is_split"):
        msg = await app.get_messages(channel_id, message_id)
        if not msg or not msg.document:
            raise HTTPException(404, "File not found on Telegram")

        mime = msg.document.mime_type or "application/octet-stream"
        size = msg.document.file_size

        async def single_stream():
            async for chunk in app.stream_media(msg, limit=size):
                yield chunk

        return StreamingResponse(
            single_stream(), media_type=mime,
            headers={"Content-Disposition": disposition, "Content-Length": str(size)},
        )

    # ── Split file — server-side merge ────────────────────────────────────────
    group_id = file_doc.get("group_id")
    if not group_id:
        raise HTTPException(500, "Missing group_id")

    parts_docs = await db.file_parts.find(
        {"group_id": group_id, "channel_id": channel_id}
    ).sort("part_num", 1).to_list(length=500)

    if not parts_docs:
        raise HTTPException(404, "No part records — run /api/sync first")

    # Fetch all part Telegram messages
    part_msg_ids = [p["message_id"] for p in parts_docs]
    tg_msgs = []
    for mid in part_msg_ids:
        m = await app.get_messages(channel_id, mid)
        if not m or not m.document:
            raise HTTPException(404, f"Part message {mid} not found on Telegram")
        tg_msgs.append(m)

    async def read_bytes_at(msg, offset: int, length: int) -> bytes:
        """Read `length` bytes starting at `offset` from a Telegram message."""
        buf = bytearray()
        async for chunk in app.stream_media(msg, offset=offset, limit=length):
            buf.extend(chunk)
            if len(buf) >= length:
                break
        return bytes(buf[:length])

    async def parse_zip_header(msg) -> tuple[int, int]:
        """
        Return (data_offset, data_size) for the single ZIP_STORED entry.
        Reads only the first 64 bytes (more than enough for the local header).
        """
        hdr = await read_bytes_at(msg, 0, 64)
        if hdr[:4] != LOCAL_HEADER_SIG:
            raise ValueError("Bad zip signature")
        method = struct.unpack_from('<H', hdr, 8)[0]
        if method != 0:
            raise ValueError(f"Expected ZIP_STORED (0), got method={method}")
        data_size  = struct.unpack_from('<I', hdr, 22)[0]
        fname_len  = struct.unpack_from('<H', hdr, 26)[0]
        extra_len  = struct.unpack_from('<H', hdr, 28)[0]
        data_offset = 30 + fname_len + extra_len
        return data_offset, data_size

    # Parse all headers up front so we can provide Content-Length
    headers_info: list[tuple] = []   # (tg_msg, data_offset, data_size)
    total_bytes = 0
    for i, msg in enumerate(tg_msgs, start=1):
        try:
            offset, size = await parse_zip_header(msg)
            headers_info.append((msg, offset, size))
            total_bytes += size
        except Exception as e:
            raise HTTPException(500, f"Part {i} header parse failed: {e}")

    # Guess MIME from filename extension
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    mime_map = {
        "mp4": "video/mp4", "mkv": "video/x-matroska",
        "avi": "video/x-msvideo", "mov": "video/quicktime",
        "webm": "video/webm", "m4v": "video/mp4",
        "mp3": "audio/mpeg", "flac": "audio/flac",
        "wav": "audio/wav", "aac": "audio/aac",
        "pdf": "application/pdf",
    }
    mime = mime_map.get(ext, "application/octet-stream")

    async def merged_stream():
        """
        Stream each part's raw data bytes in sequence.
        ZIP_STORED = no compression, so bytes inside = original file bytes.
        Concatenation recreates the original file exactly.
        """
        for msg, data_offset, data_size in headers_info:
            remaining = data_size
            pos = data_offset
            while remaining > 0:
                to_read = min(ZIP_CHUNK, remaining)
                chunk = await read_bytes_at(msg, pos, to_read)
                if not chunk:
                    break
                yield chunk
                pos += len(chunk)
                remaining -= len(chunk)

    return StreamingResponse(
        merged_stream(), media_type=mime,
        headers={
            "Content-Disposition": disposition,
            "Content-Length": str(total_bytes),
            "X-Teledrive-Parts": str(len(parts_docs)),
        },
    )


# ── Parts info ────────────────────────────────────────────────────────────────

@router.get("/{message_id}/parts")
async def get_parts(message_id: int, channel_id: int):
    db = get_db()
    file_doc = await db.files.find_one(
        {"message_id": message_id, "channel_id": channel_id}
    )
    if not file_doc:
        raise HTTPException(404, "File not found")
    if not file_doc.get("is_split"):
        return {
            "is_split": False, "total_parts": 1,
            "parts": [{"part_num": 1, "message_id": message_id,
                        "size": file_doc.get("size", 0)}],
        }
    group_id = file_doc.get("group_id")
    parts = await db.file_parts.find(
        {"group_id": group_id, "channel_id": channel_id}
    ).sort("part_num", 1).to_list(length=500)
    return {
        "is_split": True, "group_id": group_id,
        "total_parts": file_doc.get("total_parts", len(parts)),
        "filename": file_doc.get("name", ""),
        "parts": [
            {"part_num": p["part_num"], "message_id": p["message_id"],
             "size": p.get("size", 0)}
            for p in parts
        ],
    }
