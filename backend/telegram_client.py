"""
Pyrogram client singleton + caption parsing/building.

Caption format — media files:
    [IMAGE]           [VIDEO]           [AUDIO]          [DOCUMENT]
    path/to/file      path/to/file      path/to/file     path/to/file
    1920x1080         1920x1080         -                -
    thumb_msg:12345   thumb_msg:12345   thumb_msg:-      thumb_msg:-

Caption format — split parts:
    [VIDEO:PART]
    path/to/file.mp4
    1920x1080
    thumb_msg:12345
    part:1/3
    group:a8f3c2d1

Caption format — thumbnails:
    [THUMBNAIL]
    orig_msg:12345
"""

from typing import Optional
from pyrogram import Client
from pyrogram.types import User
from config import settings

_client: Optional[Client] = None

MEDIA_TYPES = {"[IMAGE]", "[VIDEO]", "[DOCUMENT]", "[AUDIO]"}


async def get_client() -> Client:
    global _client
    if _client and _client.is_connected:
        return _client

    kwargs = dict(api_id=settings.api_id, api_hash=settings.api_hash)

    if settings.bot_token:
        _client = Client("teledrive_backend_bot", bot_token=settings.bot_token, **kwargs)
    elif settings.session_string:
        _client = Client("teledrive_backend", session_string=settings.session_string, **kwargs)
    else:
        # _client = Client("teledrive_backend", **kwargs)
        print("No session_string or bot_token provided in config! Telegram client will not connect.")
        return None

    await _client.start()
    return _client


async def disconnect_client():
    global _client
    if _client and _client.is_connected:
        await _client.stop()


# ── Caption parsers ────────────────────────────────────────────────────────────

def parse_caption(caption: str) -> Optional[dict]:
    if not caption:
        return None
    lines = [l.strip() for l in caption.strip().splitlines()]
    if not lines:
        return None
    tag = lines[0]

    if tag == "[THUMBNAIL]":
        result = {"kind": "thumbnail"}
        for line in lines[1:]:
            if line.startswith("orig_msg:"):
                try:
                    result["original_message_id"] = int(line.split(":", 1)[1])
                except ValueError:
                    pass
        return result if "original_message_id" in result else None

    is_part = tag.endswith(":PART]") and tag.startswith("[")
    raw_type_tag = tag.replace(":PART]", "]") if is_part else tag

    if raw_type_tag in MEDIA_TYPES or is_part:
        media_type = raw_type_tag[1:-1].lower()
        result = {
            "kind": "file_part" if is_part else "file",
            "type": media_type,
            "path": lines[1] if len(lines) > 1 else "",
            "resolution": lines[2] if len(lines) > 2 else "-",
            "thumb_msg_id": None,
            "part_num": None,
            "total_parts": None,
            "group_id": None,
        }
        for line in lines[3:]:
            if line.startswith("thumb_msg:"):
                val = line.split(":", 1)[1]
                if val != "-":
                    try:
                        result["thumb_msg_id"] = int(val)
                    except ValueError:
                        pass
            elif line.startswith("part:"):
                try:
                    a, b = line.split(":", 1)[1].split("/")
                    result["part_num"], result["total_parts"] = int(a), int(b)
                except Exception:
                    pass
            elif line.startswith("group:"):
                result["group_id"] = line.split(":", 1)[1]
        return result

    return None


def path_to_parts(path: str) -> tuple[str, str, str]:
    parts = path.replace("\\", "/").split("/")
    name = parts[-1]
    folder_path = "/".join(parts[:-1]) if len(parts) > 1 else ""
    folder_name = parts[-2] if len(parts) > 2 else folder_path
    return folder_path, name, folder_name
