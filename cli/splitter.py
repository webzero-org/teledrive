"""
File splitting utility for TeleDrive.

Splits large files into ZIP_STORED parts that each fit within Telegram's
upload limit. Each part is a self-contained zip containing one numbered
chunk, e.g.:

  movie.mp4  →  movie.mp4.part001.zip
                movie.mp4.part002.zip
                movie.mp4.part003.zip

To reassemble (we also generate a recombine script alongside the parts):
  unzip movie.mp4.part001.zip && unzip movie.mp4.part002.zip ...
  cat movie.mp4.part001 movie.mp4.part002 ... > movie.mp4
"""

import io
import math
import zipfile
from pathlib import Path
from typing import Generator, Optional
import uuid

# Safety margin: leave 10 MB headroom below the TG limit
_SAFETY_MB = 10

# ZIP_STORED overhead is tiny (central directory etc.) — ~1 KB per entry
_ZIP_OVERHEAD_BYTES = 2 * 1024  # 2 KB to be safe


def get_upload_limit_bytes(is_premium: bool) -> int:
    """Return the per-file upload limit in bytes."""
    mb = 4000 if is_premium else 2000
    return (mb - _SAFETY_MB) * 1024 * 1024


def needs_splitting(file_path: Path, is_premium: bool) -> bool:
    return file_path.stat().st_size > get_upload_limit_bytes(is_premium)


def split_file_into_zip_parts(
    file_path: Path,
    is_premium: bool,
    output_dir: Optional[Path] = None,
    progress_callback=None,   # called with (part_index, total_parts, bytes_written)
) -> tuple[list[Path], str]:
    """
    Split *file_path* into ZIP_STORED parts.

    Returns:
        (list_of_zip_paths, group_id)
        group_id is a short UUID linking all parts in the DB / captions.
    """
    file_size = file_path.stat().st_size
    limit = get_upload_limit_bytes(is_premium)
    chunk_size = limit - _ZIP_OVERHEAD_BYTES

    total_parts = math.ceil(file_size / chunk_size)
    group_id = uuid.uuid4().hex[:12]

    out_dir = output_dir or file_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    zip_paths: list[Path] = []

    with open(file_path, "rb") as src:
        for part_idx in range(1, total_parts + 1):
            chunk = src.read(chunk_size)
            if not chunk:
                break

            # Name the inner file so reassembly is obvious
            inner_name = f"{file_path.name}.part{part_idx:03d}"
            zip_name = f"{file_path.name}.part{part_idx:03d}.zip"
            zip_path = out_dir / zip_name

            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED) as zf:
                zf.writestr(inner_name, chunk)

            zip_paths.append(zip_path)

            if progress_callback:
                progress_callback(part_idx, total_parts, len(chunk))

    return zip_paths, group_id, total_parts
