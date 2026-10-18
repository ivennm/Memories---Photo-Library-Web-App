"""Background media processing: thumbnails, video streaming copies and video capture dates.

Everything made here is a rebuildable derivative; originals are never modified (only moved into
the right YYYY/MM folder once a video's real capture date is known).
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

logger = logging.getLogger(__name__)

THUMBNAIL_DIRECTORY = "_thumbs"
STREAM_DIRECTORY = "_streams"
# Grid cards are about 200 px wide; 800 px stays sharp on high-density phone screens.
THUMBNAIL_MAX_EDGE = 800
# Streaming copies: shorter side at most 1080 px (1080p), H.264 capped near 6 Mbps.
STREAM_SHORT_EDGE = 1080
# H.264 originals at or below this bitrate already stream well and are played directly.
STREAM_SKIP_BITRATE = 8_000_000
FFMPEG_TIMEOUT_SECONDS = 3 * 60 * 60
# iPhone HDR video (HLG / Dolby Vision, or PQ) looks washed out unless tone-mapped to SDR.
HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}
TONE_MAP = (
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
    "tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv"
)


def probe(path: Path) -> dict[str, Any]:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
             str(path)],
            capture_output=True, check=True, text=True, timeout=60,
        )
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        logger.warning("ffprobe could not read %s", path, exc_info=True)
        return {}


def video_stream(info: dict[str, Any]) -> dict[str, Any]:
    return next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})


def video_capture_time(info: dict[str, Any]) -> datetime | None:
    """When the video was recorded, from its metadata.

    iPhones store the local time with its offset (com.apple.quicktime.creationdate); other
    cameras store UTC in creation_time, which is shown in the server's timezone.
    """
    format_tags = {k.lower(): v for k, v in info.get("format", {}).get("tags", {}).items()}
    stream_tags = {k.lower(): v for k, v in video_stream(info).get("tags", {}).items()}
    for raw in (
        format_tags.get("com.apple.quicktime.creationdate"),
        format_tags.get("creation_time"),
        stream_tags.get("creation_time"),
    ):
        if not raw:
            continue
        try:
            parsed = datetime.fromisoformat(raw.strip())
        except ValueError:
            continue
        if parsed.year < 1995:  # unset dates show up as 1904 or 1970
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed if parsed.utcoffset() else parsed.astimezone()
    return None


def save_thumbnail(image: Image.Image, destination: Path) -> None:
    thumbnail = ImageOps.exif_transpose(image).convert("RGB")
    thumbnail.thumbnail((THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE))
    thumbnail.save(destination, "JPEG", quality=82)


def run_ffmpeg(arguments: list[str]) -> None:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", *arguments],
        capture_output=True, check=True, timeout=FFMPEG_TIMEOUT_SECONDS,
    )


def video_filters(stream: dict[str, Any], scale: str, pixel_format: str | None = None) -> str:
    filters = [scale]
    if stream.get("color_transfer") in HDR_TRANSFERS:
        filters.append(TONE_MAP)
    if pixel_format:
        filters.append(f"format={pixel_format}")
    return ",".join(filters)


def needs_stream_copy(info: dict[str, Any], extension: str) -> bool:
    stream = video_stream(info)
    try:
        bitrate = int(info.get("format", {}).get("bit_rate") or 0)
    except ValueError:
        bitrate = 0
    audio = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    plays_directly = (
        stream.get("codec_name") == "h264"
        and extension in {"mp4", "m4v", "mov"}
        and 0 < bitrate <= STREAM_SKIP_BITRATE
        # Chrome and Edge can't play PCM audio (common in camera and editor exports).
        and (audio is None or audio.get("codec_name") in {"aac", "mp3"})
    )
    return not plays_directly


def make_video_derivatives(
    source: Path, info: dict[str, Any], thumbnail: Path, stream_copy: Path | None
) -> None:
    stream = video_stream(info)
    try:
        duration = float(info.get("format", {}).get("duration") or 0)
    except ValueError:
        duration = 0
    poster_scale = (
        f"scale='min({THUMBNAIL_MAX_EDGE},iw)':'min({THUMBNAIL_MAX_EDGE},ih)'"
        ":force_original_aspect_ratio=decrease"
    )
    run_ffmpeg([
        "-ss", f"{min(1.0, duration / 2):.2f}", "-i", str(source), "-frames:v", "1",
        "-vf", video_filters(stream, poster_scale), "-q:v", "4", str(thumbnail),
    ])
    if stream_copy is None:
        return
    # Limit the shorter side to 1080 px for both portrait and landscape video.
    stream_scale = (
        f"scale='if(lte(iw,ih),min({STREAM_SHORT_EDGE},iw),-2)'"
        f":'if(lte(iw,ih),-2,min({STREAM_SHORT_EDGE},ih))'"
    )
    temporary = stream_copy.with_suffix(".tmp.mp4")
    try:
        run_ffmpeg([
            "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?",
            # 8-bit 4:2:0 plays in every browser.
            "-vf", video_filters(stream, stream_scale, "yuv420p"),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-maxrate", "6M", "-bufsize", "12M",
            "-c:a", "aac", "-b:a", "128k",
            # Put the index first so playback starts before the whole file has downloaded.
            "-movflags", "+faststart",
            str(temporary),
        ])
        os.replace(temporary, stream_copy)
    finally:
        temporary.unlink(missing_ok=True)


def dated_relative_path(taken_at: datetime, current: str) -> str:
    """The original's path inside the folder for the month it was taken."""
    return Path(taken_at.strftime("%Y"), taken_at.strftime("%m"), Path(current).name).as_posix()


def process_item(
    connection: sqlite3.Connection, media_root: Path, row: sqlite3.Row, iso_timestamp: Any
) -> None:
    original = media_root / row["relative_path"]
    extension = original.suffix.lower().lstrip(".")
    thumbnail_path = Path(THUMBNAIL_DIRECTORY, f"{row['id']}.jpg")
    thumbnail = media_root / thumbnail_path
    thumbnail.parent.mkdir(parents=True, exist_ok=True)
    stream_path: Path | None = None
    updates: dict[str, Any] = {}

    if row["content_type"].startswith("video/"):
        info = probe(original)
        if not video_stream(info):
            raise ValueError("no video stream found")
        if needs_stream_copy(info, extension):
            stream_path = Path(STREAM_DIRECTORY, f"{row['id']}.mp4")
            (media_root / stream_path).parent.mkdir(parents=True, exist_ok=True)
        make_video_derivatives(
            original, info, thumbnail, media_root / stream_path if stream_path else None
        )
        # Videos uploaded before capture dates were read still use the upload time.
        if row["taken_at"] == row["uploaded_at"] and (taken_at := video_capture_time(info)):
            new_relative = dated_relative_path(taken_at, row["relative_path"])
            if new_relative != row["relative_path"]:
                destination = media_root / new_relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.replace(original, destination)
                updates["relative_path"] = new_relative
            updates["taken_at"] = iso_timestamp(taken_at)
    else:
        source = media_root / (row["display_path"] or row["relative_path"])
        with Image.open(source) as image:
            save_thumbnail(image, thumbnail)

    updates.update(
        thumb_path=thumbnail_path.as_posix(),
        stream_path=stream_path.as_posix() if stream_path else None,
        processing="done",
    )
    assignments = ", ".join(f"{column} = ?" for column in updates)
    cursor = connection.execute(
        f"UPDATE photos SET {assignments} WHERE id = ?", (*updates.values(), row["id"])
    )
    connection.commit()
    if cursor.rowcount == 0:
        # Deleted forever while it was being processed: remove what was just made.
        thumbnail.unlink(missing_ok=True)
        if stream_path:
            (media_root / stream_path).unlink(missing_ok=True)


def process_next(connection: sqlite3.Connection, media_root: Path, iso_timestamp: Any) -> bool:
    """Process the oldest pending item. Returns False when nothing is waiting."""
    row = connection.execute(
        "SELECT * FROM photos WHERE processing = 'pending' ORDER BY uploaded_at LIMIT 1"
    ).fetchone()
    if row is None:
        return False
    try:
        process_item(connection, media_root, row, iso_timestamp)
        logger.info("Processed %s (%s)", row["id"], row["original_name"])
    except Exception:  # one bad file must not stop the queue
        connection.rollback()
        logger.exception("Could not process %s (%s)", row["id"], row["original_name"])
        connection.execute("UPDATE photos SET processing = 'failed' WHERE id = ?", (row["id"],))
        connection.commit()
    return True
