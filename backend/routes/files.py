import re
import struct
import asyncio
import base64
import zipfile
import json
import io
import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from db import get_db
from telegram_client import get_client

router = APIRouter(prefix="/api/files", tags=["files"])

LOCAL_HEADER_SIG = b'PK\x03\x04'
ZIP_CHUNK = 512 * 1024   # 512 KB per read

THUMBS_DIR = os.getenv("THUMBS_DIR", "/tmp/teledrive_thumbs")

# Global in-memory cache for thumbnails downloaded from zips
thumb_cache = {}

async def load_thumb_zip(channel_id: int, zip_msg_id: int):
    """Downloads a thumbnail zip from Telegram and extracts it to disk."""
    app = await get_client()
    try:
        msg = await app.get_messages(channel_id, zip_msg_id)
        if msg and msg.document:
            buf = await app.download_media(msg, in_memory=True)
            if buf:
                out_dir = os.path.join(THUMBS_DIR, str(channel_id))
                os.makedirs(out_dir, exist_ok=True)
                with zipfile.ZipFile(buf) as z:
                    z.extractall(out_dir)
                print(f"[THUMB ZIP] Extracted thumbnails for channel {channel_id} to {out_dir}")
    except Exception as e:
        print(f"[THUMB ZIP] Error loading zip for {channel_id}: {e}")

async def load_all_thumb_zips():
    """Initializes the thumbnail cache using channel thumb_zip_id records."""
    db = get_db()
    channels = await db.channels.find({"thumb_zip_id": {"$exists": True}}).to_list(1000)
    for ch in channels:
        await load_thumb_zip(ch["channel_id"], ch["thumb_zip_id"])

def _serialize(doc) -> dict:
    doc["id"] = str(doc.pop("_id"))
    return doc


class MoveRequest(BaseModel):
    message_ids: list[int]
    channel_id: int
    new_folder_path: str


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
        # Exact match hits the compound index directly.
        # Regex for recursive mode still benefits from the channel_id prefix.
        query["folder_path"] = (
            {"$regex": f"^{re.escape(path)}"} if recursive else path
        )

    # Fetch docs and total count in parallel — halves round-trip latency.
    cursor = db.files.find(query).skip(skip).limit(limit).sort("name", 1)
    docs, total = await asyncio.gather(
        cursor.to_list(length=limit),
        db.files.count_documents(query),
    )

    # Batch-resolve split-file sizes in one query (avoid N+1).
    split_group_ids = [
        doc["group_id"] for doc in docs
        if doc.get("is_split") and doc.get("group_id")
    ]
    if split_group_ids:
        all_parts = await db.file_parts.find(
            {"group_id": {"$in": split_group_ids}, "channel_id": channel_id},
            {"group_id": 1, "size": 1},
        ).to_list(length=None)
        size_map: dict = {}
        for p in all_parts:
            gid = p["group_id"]
            size_map[gid] = size_map.get(gid, 0) + p.get("size", 0)
        for doc in docs:
            gid = doc.get("group_id")
            if gid and gid in size_map:
                doc["size"] = size_map[gid]

    return {"total": total, "items": [_serialize(d) for d in docs]}



@router.get("/folders")
async def list_folders(channel_id: int):
    db = get_db()
    paths = await db.files.distinct("folder_path", {"channel_id": channel_id})
    return {"folders": sorted(p for p in paths if p is not None)}


@router.post("/move")
async def move_files(req: MoveRequest):
    db = get_db()
    
    result = await db.files.update_many(
        {"message_id": {"$in": req.message_ids}, "channel_id": req.channel_id},
        {"$set": {"folder_path": req.new_folder_path}}
    )
    
    docs = await db.files.find(
        {"message_id": {"$in": req.message_ids}, "channel_id": req.channel_id, "is_split": True}
    ).to_list(length=None)
    
    group_ids = [d["group_id"] for d in docs if d.get("group_id")]
    if group_ids:
        await db.file_parts.update_many(
            {"group_id": {"$in": group_ids}, "channel_id": req.channel_id},
            {"$set": {"folder_path": req.new_folder_path}}
        )
        
    return {"ok": True, "modified": result.modified_count}


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
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/thumbnails")
async def get_thumbnails_batch(message_ids: str, channel_id: int):
    """Batch fetch thumbnails as base64."""
    mids = [int(x) for x in message_ids.split(",") if x.strip()]
    if not mids:
        return {}
        
    res = {}
    missing_mids = []
    
    map_file = os.path.join(THUMBS_DIR, str(channel_id), "mapping.json")
    mapping = {}
    if os.path.exists(map_file):
        try:
            with open(map_file, "r") as f:
                mapping = json.load(f)
        except Exception:
            pass

    # Check memory cache and disk first
    for m in mids:
        cached = thumb_cache.get((channel_id, m))
        if cached:
            res[str(m)] = cached
        else:
            filename = mapping.get(str(m))
            disk_loaded = False
            if filename:
                file_path = os.path.join(THUMBS_DIR, str(channel_id), filename)
                if os.path.exists(file_path):
                    try:
                        with open(file_path, "rb") as f:
                            b64 = base64.b64encode(f.read()).decode("utf-8")
                            data_str = f"data:image/jpeg;base64,{b64}"
                            thumb_cache[(channel_id, m)] = data_str
                            res[str(m)] = data_str
                            disk_loaded = True
                    except Exception:
                        pass
            if not disk_loaded:
                missing_mids.append(m)
            
    if not missing_mids:
        return res
    
    db = get_db()
    docs = await db.files.find(
        {"message_id": {"$in": missing_mids}, "channel_id": channel_id}
    ).to_list(length=1000)
    
    doc_map = {}
    thumb_msg_ids = []
    for doc in docs:
        tmid = doc.get("thumb_msg_id")
        if tmid:
            thumb_msg_ids.append(tmid)
            doc_map[tmid] = doc["message_id"]
            
    if not thumb_msg_ids:
        return res
        
    app = await get_client()
    for i in range(0, len(thumb_msg_ids), 200):
        chunk_ids = thumb_msg_ids[i:i+200]
        msgs = await app.get_messages(channel_id, chunk_ids)
        
        async def dl(msg):
            try:
                if msg and msg.document:
                    buf = await app.download_media(msg, in_memory=True)
                    if buf:
                        b64 = base64.b64encode(buf.getbuffer()).decode('utf-8')
                        orig_mid = doc_map.get(msg.id)
                        if orig_mid:
                            data_str = f"data:image/jpeg;base64,{b64}"
                            # Also cache it for the future
                            thumb_cache[(channel_id, orig_mid)] = data_str
                            return str(orig_mid), data_str
            except Exception:
                pass
            return None

        tasks = [dl(m) for m in msgs if m]
        results = await asyncio.gather(*tasks)
        for r in results:
            if r:
                res[r[0]] = r[1]
                
    return res


# ── Storage cleanup ───────────────────────────────────────────────────────────

# @router.delete("/cleanup")
# async def cleanup_storage(channel_id: int, dry_run: bool = True):
#     """
#     Remove orphaned/stale records to keep free-tier MongoDB storage healthy.

#     Removes:
#     - file_parts records whose parent file doc no longer exists
#     - Duplicate message_id entries in files collection (keeps newest)

#     Use dry_run=false to actually delete.
#     """
#     db = get_db()
#     report = {"dry_run": dry_run, "removed": {}}

#     # 1. Find orphaned file_parts (group_id not in any files doc)
#     all_group_ids = set()
#     async for doc in db.files.find({"channel_id": channel_id, "group_id": {"$exists": True}}, {"group_id": 1}):
#         if doc.get("group_id"):
#             all_group_ids.add(doc["group_id"])

#     orphan_parts_q = {
#         "channel_id": channel_id,
#         "group_id": {"$nin": list(all_group_ids)},
#     }
#     orphan_parts_count = await db.file_parts.count_documents(orphan_parts_q)
#     report["removed"]["orphan_parts"] = orphan_parts_count
#     if not dry_run and orphan_parts_count > 0:
#         await db.file_parts.delete_many(orphan_parts_q)

#     # 2. Find duplicate message_ids in files (keep first seen)
#     pipeline = [
#         {"$match": {"channel_id": channel_id}},
#         {"$group": {"_id": "$message_id", "count": {"$sum": 1}, "ids": {"$push": "$_id"}}},
#         {"$match": {"count": {"$gt": 1}}},
#     ]
#     dups = await db.files.aggregate(pipeline).to_list(length=10000)
#     dup_ids_to_remove = []
#     for dup in dups:
#         # keep first, remove rest
#         dup_ids_to_remove.extend(dup["ids"][1:])

#     report["removed"]["duplicate_file_docs"] = len(dup_ids_to_remove)
#     if not dry_run and dup_ids_to_remove:
#         await db.files.delete_many({"_id": {"$in": dup_ids_to_remove}})

#     return report


# ── Download (single file or server-side-merged split file) ───────────────────

@router.get("/{message_id}/download")
async def download_file(message_id: int, channel_id: int, request: Request, inline: bool = False):
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

    async def stream_telegram_bytes(app, msg, offset_bytes: int, length_bytes: int):
        CHUNK_SIZE = 1024 * 1024
        file_size = msg.document.file_size
        if offset_bytes >= file_size or length_bytes <= 0:
            return

        chunk_index = offset_bytes // CHUNK_SIZE
        skip_bytes = offset_bytes % CHUNK_SIZE
        
        remaining = length_bytes
        async for chunk in app.stream_media(msg, offset=chunk_index):
            if skip_bytes > 0:
                if skip_bytes >= len(chunk):
                    skip_bytes -= len(chunk)
                    continue
                else:
                    chunk = chunk[skip_bytes:]
                    skip_bytes = 0
                    
            if len(chunk) > remaining:
                chunk = chunk[:remaining]
                
            if len(chunk) > 0:
                yield chunk
                remaining -= len(chunk)
                
            if remaining <= 0:
                break

    # ── Non-split file ────────────────────────────────────────────────────────
    if not file_doc.get("is_split"):
        msg = await app.get_messages(channel_id, message_id)
        if not msg or not msg.document:
            raise HTTPException(404, "File not found on Telegram")

        mime = msg.document.mime_type or "application/octet-stream"
        size = msg.document.file_size

        range_header = request.headers.get('Range')
        start = 0
        end = size - 1
        if range_header:
            match = re.match(r"bytes=(\d+)-(.*)", range_header)
            if match:
                start = int(match.group(1))
                if match.group(2):
                    end = int(match.group(2))
        
        length = end - start + 1
        headers = {
            "Content-Disposition": disposition,
            "Accept-Ranges": "bytes",
            "Content-Length": str(length),
        }

        async def single_stream():
            async for chunk in stream_telegram_bytes(app, msg, start, length):
                yield chunk

        if range_header:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            return StreamingResponse(single_stream(), status_code=206, media_type=mime, headers=headers)

        return StreamingResponse(
            single_stream(), media_type=mime,
            headers=headers,
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
        async for chunk in stream_telegram_bytes(app, msg, offset, length):
            buf.extend(chunk)
        return bytes(buf)

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
    
    try:
        offset_1, size_1 = await parse_zip_header(tg_msgs[0])
    except Exception as e:
        raise HTTPException(500, f"Part 1 header parse failed: {e}")

    is_split_zip = False
    if len(tg_msgs) > 1:
        hdr_2 = await read_bytes_at(tg_msgs[1], 0, 4)
        if hdr_2 != LOCAL_HEADER_SIG:
            is_split_zip = True

    total_bytes = 0

    if is_split_zip:
        if size_1 > 0 and size_1 != 0xFFFFFFFF:
            total_bytes = size_1
        else:
            total_bytes = sum(m.document.file_size for m in tg_msgs) - offset_1

        current_size_left = total_bytes
        for i, msg in enumerate(tg_msgs):
            if current_size_left <= 0:
                break
            part_offset = offset_1 if i == 0 else 0
            max_avail = msg.document.file_size - part_offset
            part_size = min(current_size_left, max_avail)
            headers_info.append((msg, part_offset, part_size))
            current_size_left -= part_size
    else:
        for i, msg in enumerate(tg_msgs):
            if i == 0:
                offset, size = offset_1, size_1
            else:
                try:
                    offset, size = await parse_zip_header(msg)
                except Exception as e:
                    raise HTTPException(500, f"Part {i+1} header parse failed: {e}")
            
            if size == 0 or size == 0xFFFFFFFF:
                size = msg.document.file_size - offset
            
            headers_info.append((msg, offset, size))
            total_bytes += size

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

    start = 0
    end = total_bytes - 1
    range_header = request.headers.get('Range')
    if range_header:
        match = re.match(r"bytes=(\d+)-(.*)", range_header)
        if match:
            start = int(match.group(1))
            if match.group(2):
                end = int(match.group(2))
                
    length = end - start + 1

    headers = {
        "Content-Disposition": disposition,
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "X-Teledrive-Parts": str(len(parts_docs)),
    }

    async def merged_stream():
        """
        Stream each part's raw data bytes in sequence.
        ZIP_STORED = no compression, so bytes inside = original file bytes.
        Concatenation recreates the original file exactly.
        """
        current_global_offset = 0
        for msg, data_offset, data_size in headers_info:
            part_start = current_global_offset
            part_end = current_global_offset + data_size - 1
            current_global_offset += data_size
            
            if part_end < start or part_start > end:
                continue
                
            read_start = max(start, part_start)
            read_end = min(end, part_end)
            read_len = read_end - read_start + 1
            
            remaining = read_len
            local_offset = data_offset + (read_start - part_start)
            
            async for chunk in stream_telegram_bytes(app, msg, local_offset, read_len):
                yield chunk

    if range_header:
        headers["Content-Range"] = f"bytes {start}-{end}/{total_bytes}"
        return StreamingResponse(merged_stream(), status_code=206, media_type=mime, headers=headers)

    return StreamingResponse(
        merged_stream(), media_type=mime,
        headers=headers,
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
