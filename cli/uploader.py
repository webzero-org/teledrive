#!/usr/bin/env python3
"""
TeleDrive CLI uploader  —  Pyrogram edition

Commands:
  upload      Walk a folder and upload to a Telegram channel
  gen-session Interactive login, prints reusable session string
  sync        Trigger backend DB rebuild from Telegram captions
  cleanup     Fix/delete bad thumbnail messages in a channel:
                - delete thumbnails with orig_msg:0 (orphaned)
                - strip orig_file: line from existing thumbnails
"""

import asyncio
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import click
import httpx
from PIL import Image
from pyrogram import Client
from pyrogram.types import Message
from rich.console import Console
from rich.markup import escape
from rich.progress import (
    BarColumn, MofNCompleteColumn, Progress, SpinnerColumn,
    TaskProgressColumn, TextColumn, TimeElapsedColumn, TimeRemainingColumn,
    TransferSpeedColumn,
)

from splitter import needs_splitting, split_file_into_zip_parts

console = Console()

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".heic"}
VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"}
AUDIO_EXTS = {".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".opus"}

PROGRESS_FILE = ".teledrive_progress.json"


# ── Caption builders ──────────────────────────────────────────────────────────

def build_file_caption(media_type, path, resolution="-", thumb_msg_id=None):
    thumb = str(thumb_msg_id) if thumb_msg_id else "-"
    return f"[{media_type}]\n{path}\n{resolution}\nthumb_msg:{thumb}"


def build_part_caption(media_type, path, resolution, thumb_msg_id,
                       part_num, total_parts, group_id):
    thumb = str(thumb_msg_id) if thumb_msg_id else "-"
    return (
        f"[{media_type}:PART]\n{path}\n{resolution}\n"
        f"thumb_msg:{thumb}\npart:{part_num}/{total_parts}\ngroup:{group_id}"
    )


def build_thumbnail_caption(orig_msg_id):
    return f"[THUMBNAIL]\norig_msg:{orig_msg_id}"


# ── Progress state ────────────────────────────────────────────────────────────

def load_progress(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return {}


def save_progress(path: Path, state: dict):
    path.write_text(json.dumps(state, indent=2))


def file_key(path: Path, base: Path) -> str:
    return str(path.relative_to(base))


# ── Thumbnail generation ──────────────────────────────────────────────────────

def make_image_thumbnail(src: Path, max_size: int) -> tuple:
    try:
        img = Image.open(src).convert("RGB")
        w, h = img.size
        resolution = f"{w}x{h}"
        if max(w, h) > max_size:
            r = max_size / max(w, h)
            img = img.resize((int(w * r), int(h * r)), Image.LANCZOS)
        tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
        img.save(tmp.name, "JPEG", quality=82, optimize=True)
        return Path(tmp.name), resolution
    except Exception as e:
        console.print(f"[yellow]  ⚠ image thumb failed: {escape(str(e))}[/]")
        return None, "-"


def make_video_thumbnail(src: Path) -> tuple:
    try:
        import json as _j
        probe = subprocess.run(
            ["ffprobe", "-v", "error",
             "-show_entries", "format=duration:stream=width,height",
             "-select_streams", "v:0", "-of", "json", str(src)],
            capture_output=True, text=True, timeout=30,
        )
        data = _j.loads(probe.stdout)
        duration = float(data.get("format", {}).get("duration", 10))
        streams = data.get("streams", [{}])
        w, h = streams[0].get("width", 0), streams[0].get("height", 0)
        resolution = f"{w}x{h}" if w and h else "-"
        seek = max(0.0, duration * 0.10)
        tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
        subprocess.run(
            ["ffmpeg", "-ss", str(seek), "-i", str(src),
             "-vframes", "1", "-q:v", "3", "-vf", "scale=720:-2",
             "-y", tmp.name],
            capture_output=True, timeout=60,
        )
        return (Path(tmp.name) if Path(tmp.name).stat().st_size > 0 else None), resolution
    except FileNotFoundError:
        console.print("[yellow]  ⚠ ffmpeg not found — video thumbs skipped[/]")
        return None, "-"
    except Exception as e:
        console.print(f"[yellow]  ⚠ video thumb failed: {escape(str(e))}[/]")
        return None, "-"


# ── Pyrogram upload helper ────────────────────────────────────────────────────

async def pyro_upload(
    app: Client,
    channel_id: int,
    local_path: Path,
    caption: str,
    prog,
    task_id,
) -> tuple[int, str]:
    bytes_so_far = [0]

    def progress(current: int, total: int):
        delta = current - bytes_so_far[0]
        if delta > 0:
            prog.advance(task_id, delta)
        bytes_so_far[0] = current

    msg: Message = await app.send_document(
        chat_id=channel_id,
        document=str(local_path),
        caption=caption,
        file_name=local_path.name,
        disable_content_type_detection=True,
        progress=progress,
    )
    return msg.id, str(msg.document.file_id)


async def check_premium(app: Client) -> bool:
    me = await app.get_me()
    return bool(getattr(me, "is_premium", False))


# ── Single file upload (with split support) ───────────────────────────────────

async def upload_one(
    app: Client,
    channel_id: int,
    local_file: Path,
    rel_path: str,
    media_type: str,
    is_premium: bool,
    thumb_size: int,
    prog: Progress,
    sem: asyncio.Semaphore,
) -> dict:
    async with sem:
        console.print(
            f"\n[bold]{escape(rel_path)}[/]  "
            f"[dim]{media_type} · {local_file.stat().st_size / 1024 / 1024:.1f} MB[/]"
        )
        tg_path = rel_path.replace("\\", "/")
        thumb_msg_id = None
        resolution = "-"

        # Thumbnail
        thumb_local = None
        if media_type == "IMAGE":
            thumb_local, resolution = make_image_thumbnail(local_file, thumb_size)
        elif media_type == "VIDEO":
            thumb_local, resolution = make_video_thumbnail(local_file)

        if thumb_local and thumb_local.exists():
            t_task = prog.add_task(f"  ↑ thumb/{local_file.name}",
                                   total=thumb_local.stat().st_size)
            thumb_msg_id, _ = await pyro_upload(
                app, channel_id, thumb_local,
                build_thumbnail_caption(0),
                prog, t_task,
            )
            prog.remove_task(t_task)
            try:
                thumb_local.unlink()
            except Exception:
                pass

        if needs_splitting(local_file, is_premium):
            size_mb = local_file.stat().st_size / 1024 / 1024
            limit_mb = 4000 if is_premium else 2000
            console.print(f"  [yellow]⚡ {size_mb:.0f} MB > {limit_mb} MB — splitting[/]")
            return await _upload_split(
                app, channel_id, local_file, tg_path,
                media_type, is_premium, resolution, thumb_msg_id, prog,
            )

        # Single upload
        file_size = local_file.stat().st_size
        u_task = prog.add_task(f"  ↑ {local_file.name}", total=file_size)
        caption = build_file_caption(media_type, tg_path, resolution, thumb_msg_id)
        main_msg_id, _ = await pyro_upload(app, channel_id, local_file, caption, prog, u_task)
        prog.remove_task(u_task)

        if thumb_msg_id:
            await app.edit_message_caption(
                channel_id, thumb_msg_id, build_thumbnail_caption(main_msg_id)
            )

        return {"message_id": main_msg_id, "thumb_msg_id": thumb_msg_id,
                "type": media_type, "split": False}


async def _upload_split(
    app, channel_id, local_file, tg_path,
    media_type, is_premium, resolution, thumb_msg_id, prog,
) -> dict:
    with tempfile.TemporaryDirectory() as tmpdir:
        s_task = prog.add_task(f"  ✂ splitting {local_file.name}…", total=None)
        zip_paths, group_id, total_parts = split_file_into_zip_parts(
            local_file, is_premium=is_premium, output_dir=Path(tmpdir),
        )
        prog.remove_task(s_task)

        part_msg_ids = []
        first_msg_id = None

        for part_idx, zip_path in enumerate(zip_paths, start=1):
            u_task = prog.add_task(
                f"  ↑ part {part_idx}/{total_parts}", total=zip_path.stat().st_size
            )
            caption = build_part_caption(
                media_type, tg_path, resolution,
                thumb_msg_id if part_idx == 1 else None,
                part_idx, total_parts, group_id,
            )
            msg_id, _ = await pyro_upload(app, channel_id, zip_path, caption, prog, u_task)
            prog.remove_task(u_task)
            part_msg_ids.append(msg_id)

            if part_idx == 1:
                first_msg_id = msg_id
                if thumb_msg_id:
                    await app.edit_message_caption(
                        channel_id, thumb_msg_id, build_thumbnail_caption(first_msg_id)
                    )

    return {
        "message_id": first_msg_id,
        "part_msg_ids": part_msg_ids,
        "total_parts": total_parts,
        "group_id": group_id,
        "thumb_msg_id": thumb_msg_id,
        "type": media_type,
        "split": True,
    }


# ── Folder walker ─────────────────────────────────────────────────────────────

async def do_upload(
    app, folder, channel_id, progress_path, dry_run,
    thumb_size, backend_url, is_premium, parallel,
):
    state = load_progress(progress_path)
    limit_mb = 4000 if is_premium else 2000
    console.print(
        f"[bold]Account:[/] {'✨ Premium' if is_premium else 'Standard'} "
        f"· limit [cyan]{limit_mb} MB/file[/] · parallel [cyan]{parallel}[/]"
    )

    all_files = sorted([
        p for p in folder.rglob("*")
        if p.is_file()
        and not p.name.startswith(".")
        and p.suffix.lower() not in {".json"}
    ])

    done = sum(1 for f in all_files if file_key(f, folder) in state)
    pending = [f for f in all_files if file_key(f, folder) not in state]
    console.print(
        f"[bold]Files:[/] {len(all_files)} total · "
        f"[green]{done} done[/] · {len(pending)} remaining\n"
    )

    if not pending:
        console.print("[green]All files already uploaded.[/]")
        return

    sem = asyncio.Semaphore(parallel)

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]{task.description}"),
        BarColumn(), MofNCompleteColumn(), TaskProgressColumn(),
        TransferSpeedColumn(), TimeElapsedColumn(), TimeRemainingColumn(),
        console=console, expand=True,
    ) as prog:
        overall = prog.add_task("Overall", total=len(pending))

        async def process(local_file: Path):
            rel = file_key(local_file, folder)
            ext = local_file.suffix.lower()
            media_type = (
                "IMAGE" if ext in IMAGE_EXTS else
                "VIDEO" if ext in VIDEO_EXTS else
                "AUDIO" if ext in AUDIO_EXTS else
                "DOCUMENT"
            )

            if dry_run:
                note = " (will split)" if needs_splitting(local_file, is_premium) else ""
                console.print(f"[dim]{escape(rel)}  DRY RUN{note}[/]")
                state[rel] = {"skipped": True}
                save_progress(progress_path, state)
                prog.advance(overall, 1)
                return

            try:
                result = await upload_one(
                    app, channel_id, local_file, rel,
                    media_type, is_premium, thumb_size, prog, sem,
                )
                state[rel] = result
                save_progress(progress_path, state)
                if result.get("split"):
                    console.print(
                        f"  [green]✓[/] {result['total_parts']} parts · group {result['group_id']}"
                    )
                else:
                    console.print(f"  [green]✓[/] msg {result['message_id']}")
            except Exception as e:
                # escape() prevents Rich from interpreting error text as markup
                console.print(f"  [red]✗[/] {escape(str(e))}")
            prog.advance(overall, 1)

        await asyncio.gather(*[process(f) for f in pending])

    console.print(f"\n[bold green]Done. Progress: {progress_path}[/]")

    if backend_url:
        try:
            async with httpx.AsyncClient(timeout=30) as http:
                r = await http.post(f"{backend_url}/api/sync", json={"channel_id": channel_id})
                console.print(
                    f"[dim]Backend sync "
                    f"{'triggered ✓' if r.status_code == 200 else 'failed: ' + r.text}[/]"
                )
        except Exception as e:
            console.print(f"[dim]Backend sync skipped: {escape(str(e))}[/]")


# ── Cleanup: fix old thumbnail captions, delete orphans ──────────────────────

async def do_cleanup(app: Client, channel_id: int, dry_run: bool):
    """
    Scan all messages in the channel and:
      1. Delete thumbnail messages where orig_msg:0  (upload failed, orphaned)
      2. Strip orig_file: line from thumbnail captions that still have it
    """
    deleted = 0
    edited = 0
    scanned = 0

    console.print(f"[bold]Scanning channel {channel_id}…[/] (this may take a while)\n")

    async for msg in app.get_chat_history(channel_id):
        scanned += 1
        if scanned % 500 == 0:
            console.print(f"  [dim]scanned {scanned} messages…[/]")

        caption = msg.caption
        if not caption:
            continue

        lines = [l.strip() for l in caption.strip().splitlines()]
        if not lines or lines[0] != "[THUMBNAIL]":
            continue

        # Parse orig_msg
        orig_msg_id = None
        has_orig_file = False
        for line in lines[1:]:
            if line.startswith("orig_msg:"):
                try:
                    orig_msg_id = int(line.split(":", 1)[1])
                except ValueError:
                    pass
            if line.startswith("orig_file:"):
                has_orig_file = True

        # Case 1: orphaned thumbnail (upload failed before main file was sent)
        if orig_msg_id == 0:
            if dry_run:
                console.print(f"  [dim][DRY RUN] would delete orphan thumbnail msg {msg.id}[/]")
            else:
                try:
                    await app.delete_messages(channel_id, msg.id)
                    console.print(f"  [red]✗ deleted[/] orphan thumbnail msg {msg.id}")
                    deleted += 1
                except Exception as e:
                    console.print(f"  [yellow]⚠ could not delete msg {msg.id}: {escape(str(e))}[/]")
            continue

        # Case 2: has orig_file: line that should be removed
        if has_orig_file:
            clean_lines = [l for l in lines if not l.startswith("orig_file:")]
            new_caption = "\n".join(clean_lines)
            if dry_run:
                console.print(f"  [dim][DRY RUN] would strip orig_file from thumbnail msg {msg.id}[/]")
            else:
                try:
                    await app.edit_message_caption(channel_id, msg.id, new_caption)
                    console.print(f"  [green]✓ cleaned[/] thumbnail msg {msg.id}")
                    edited += 1
                except Exception as e:
                    console.print(f"  [yellow]⚠ could not edit msg {msg.id}: {escape(str(e))}[/]")

    console.print(
        f"\n[bold]Done.[/] Scanned {scanned} messages · "
        f"[red]deleted {deleted} orphans[/] · "
        f"[green]edited {edited} captions[/]"
    )


# ── CLI ───────────────────────────────────────────────────────────────────────

@click.group()
def cli():
    pass


def _make_client(api_id, api_hash, session_string, bot_token):
    if bot_token:
        return Client("teledrive_bot", api_id=api_id, api_hash=api_hash,
                      bot_token=bot_token, in_memory=True)
    if session_string:
        return Client("teledrive_user", api_id=api_id, api_hash=api_hash,
                      session_string=session_string, in_memory=True)
    raise click.UsageError("Provide --session-string or --bot-token")


@cli.command()
@click.option("--folder",         required=True, type=click.Path(exists=True))
@click.option("--channel",        required=True, type=int)
@click.option("--api-id",         envvar="API_ID",         required=True, type=int)
@click.option("--api-hash",       envvar="API_HASH",       required=True)
@click.option("--session-string", envvar="SESSION_STRING", default=None)
@click.option("--bot-token",      envvar="BOT_TOKEN",      default=None)
@click.option("--backend",        envvar="BACKEND_URL",    default=None)
@click.option("--thumbnail-size", default=720, show_default=True)
@click.option("--parallel",       default=3, show_default=True)
@click.option("--progress-file",  default=None)
@click.option("--dry-run",        is_flag=True, default=False)
def upload(folder, channel, api_id, api_hash, session_string, bot_token,
           backend, thumbnail_size, parallel, progress_file, dry_run):
    """Walk a folder and upload everything to a Telegram channel."""
    folder_path = Path(folder).resolve()
    progress_path = Path(progress_file) if progress_file else folder_path / PROGRESS_FILE

    async def run():
        app = _make_client(api_id, api_hash, session_string, bot_token)
        async with app:
            console.print("[green]✓ Connected to Telegram[/]")
            is_premium = await check_premium(app) if not bot_token else False
            await do_upload(
                app=app, folder=folder_path, channel_id=channel,
                progress_path=progress_path, dry_run=dry_run,
                thumb_size=thumbnail_size, backend_url=backend,
                is_premium=is_premium, parallel=parallel,
            )
    asyncio.run(run())


@cli.command("gen-session")
@click.option("--api-id",   envvar="API_ID",   required=True, type=int)
@click.option("--api-hash", envvar="API_HASH", required=True)
def gen_session(api_id, api_hash):
    """Interactive login — prints a reusable session string."""
    async def run():
        app = Client("_teledrive_tmp", api_id=api_id, api_hash=api_hash, in_memory=True)
        async with app:
            ss = await app.export_session_string()
            console.print("\n[bold green]Session string (save as SESSION_STRING in .env):[/]")
            console.print(ss)
    asyncio.run(run())


@cli.command()
@click.option("--channel", required=True, type=int)
@click.option("--backend", envvar="BACKEND_URL", required=True)
def sync(channel, backend):
    """Trigger backend DB rebuild from Telegram captions."""
    async def run():
        async with httpx.AsyncClient(timeout=30) as http:
            r = await http.post(f"{backend}/api/sync", json={"channel_id": channel})
            if r.status_code == 200:
                console.print("[green]✓ Sync triggered[/]")
            else:
                console.print(f"[red]✗ {r.status_code}: {escape(r.text)}[/]")
    asyncio.run(run())


@cli.command()
@click.option("--channel",        required=True, type=int)
@click.option("--api-id",         envvar="API_ID",         required=True, type=int)
@click.option("--api-hash",       envvar="API_HASH",       required=True)
@click.option("--session-string", envvar="SESSION_STRING", default=None)
@click.option("--bot-token",      envvar="BOT_TOKEN",      default=None)
@click.option("--dry-run",        is_flag=True, default=False,
              help="Show what would be changed without doing it")
def cleanup(channel, api_id, api_hash, session_string, bot_token, dry_run):
    """
    Scan channel messages and clean up thumbnail captions:
      - Delete thumbnails with orig_msg:0 (orphaned from failed uploads)
      - Strip orig_file: lines from existing thumbnail captions
    """
    async def run():
        app = _make_client(api_id, api_hash, session_string, bot_token)
        async with app:
            console.print("[green]✓ Connected to Telegram[/]")
            await do_cleanup(app, channel, dry_run)
    asyncio.run(run())


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv("backend/.env")
    cli()
