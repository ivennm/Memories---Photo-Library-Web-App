from __future__ import annotations

import io
import sqlite3
import subprocess
from datetime import datetime, timezone

import pytest
from PIL import Image

from backend import media
from backend.app import create_app


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "db" / "library.sqlite3"))
    monkeypatch.setenv("MEDIA_ROOT", str(tmp_path / "media"))
    monkeypatch.setenv("SECRET_KEY", "test-secret")
    application = create_app()
    application.config.update(TESTING=True)
    return application


@pytest.fixture()
def client(app):
    client = app.test_client()
    assert client.post(
        "/api/first-user", json={"username": "family", "password": "a-long-test-password"}
    ).status_code == 201
    return client


def upload(client, contents, name):
    return client.post(
        "/api/photos",
        data={"file": (io.BytesIO(contents), name)},
        content_type="multipart/form-data",
    )


def make_video(path, *metadata, size="640x1136", seconds=2, codec="mpeg4", extra=()):
    """A short test video; portrait by default, like iPhone footage.

    The default codec (MPEG-4 Part 2) doesn't stream in browsers, like iPhone HEVC, so it
    always gets a streaming copy; the test pattern compresses too well to exceed the
    bitrate threshold as H.264.
    """
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size={size}:rate=30",
         "-f", "lavfi", "-i", f"sine=duration={seconds}", "-shortest",
         *[arg for item in metadata for arg in ("-metadata", item)], *extra,
         "-c:v", codec, "-b:v", "12M", "-c:a", "aac", str(path)],
        check=True,
    )
    return path.read_bytes()


def process_all(app):
    result = app.test_cli_runner().invoke(args=["process-media"])
    assert result.exit_code == 0, result.output


def test_photo_gets_a_thumbnail_after_processing(client, app):
    image = io.BytesIO()
    Image.new("RGB", (3000, 2000), "orange").save(image, "JPEG")
    assert upload(client, image.getvalue(), "big.jpg").status_code == 201
    photo = client.get("/api/photos").json[0]
    assert photo["processing"] == "pending" and photo["thumbnail_url"] is None

    process_all(app)
    photo = client.get("/api/photos").json[0]
    assert photo["processing"] == "done"
    thumbnail = client.get(photo["thumbnail_url"])
    assert thumbnail.mimetype == "image/jpeg"
    with Image.open(io.BytesIO(thumbnail.data)) as small:
        assert max(small.size) == media.THUMBNAIL_MAX_EDGE
    # The original is untouched.
    assert client.get(photo["original_url"]).data == image.getvalue()


def test_video_date_is_read_at_upload_and_streaming_copy_is_made(client, app, tmp_path):
    contents = make_video(
        tmp_path / "clip.mov", "creation_time=2019-07-04T19:30:00Z", extra=("-f", "mov")
    )
    assert upload(client, contents, "IMG_0001.MOV").status_code == 201
    video = client.get("/api/photos").json[0]
    taken = datetime.fromisoformat(video["taken_at"])
    assert taken == datetime(2019, 7, 4, 19, 30, tzinfo=timezone.utc)
    assert list((app.config["MEDIA_ROOT"] / "2019" / "07").iterdir())

    process_all(app)
    video = client.get("/api/photos").json[0]
    assert video["processing"] == "done"
    assert client.get(video["thumbnail_url"]).mimetype == "image/jpeg"
    stream = client.get(video["content_url"])
    assert stream.mimetype == "video/mp4"
    info = media.probe(app.config["MEDIA_ROOT"] / "_streams" / f"{video['id']}.mp4")
    stream_info = media.video_stream(info)
    assert stream_info["codec_name"] == "h264"
    assert (stream_info["width"], stream_info["height"]) == (640, 1136)  # never upscaled
    assert client.get(video["original_url"]).data == contents

    # Seeking in the player uses range requests.
    partial = client.get(video["content_url"], headers={"Range": "bytes=0-99"})
    assert partial.status_code == 206 and len(partial.data) == 100


def test_large_video_is_scaled_to_1080p(app, tmp_path):
    source = tmp_path / "landscape.mp4"
    make_video(source, size="2560x1440", seconds=1)
    info = media.probe(source)
    assert media.needs_stream_copy(info, "mp4")
    copy = tmp_path / "copy.mp4"
    media.make_video_derivatives(source, info, tmp_path / "poster.jpg", copy)
    stream = media.video_stream(media.probe(copy))
    assert (stream["width"], stream["height"]) == (1920, 1080)
    with Image.open(tmp_path / "poster.jpg") as poster:
        assert poster.size == (800, 450)


def test_small_h264_video_plays_without_a_copy(client, app, tmp_path):
    contents = make_video(tmp_path / "small.mp4", codec="libx264", extra=("-maxrate", "1M", "-bufsize", "2M"))
    assert upload(client, contents, "small.mp4").status_code == 201
    process_all(app)
    video = client.get("/api/photos").json[0]
    assert video["processing"] == "done" and video["thumbnail_url"]
    assert client.get(video["content_url"]).data == contents
    assert not (app.config["MEDIA_ROOT"] / "_streams").exists()


def test_older_video_is_moved_to_its_capture_month(client, app, tmp_path):
    contents = make_video(tmp_path / "old.mov", "creation_time=2018-12-25T15:00:00Z", extra=("-f", "mov"))
    assert upload(client, contents, "old.mov").status_code == 201
    # Simulate a video uploaded before capture dates were read: dated by upload time.
    with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
        connection.execute(
            "UPDATE photos SET taken_at = uploaded_at, relative_path = '2026/10/' || "
            "substr(relative_path, 9)"
        )
        relative = connection.execute("SELECT relative_path FROM photos").fetchone()[0]
    media_root = app.config["MEDIA_ROOT"]
    (media_root / "2026" / "10").mkdir(parents=True)
    next((media_root / "2018").rglob("*.mov")).rename(media_root / relative)

    process_all(app)
    video = client.get("/api/photos").json[0]
    assert video["taken_at"] == "2018-12-25T15:00:00Z"
    assert not list((media_root / "2026" / "10").iterdir())
    assert client.get(video["original_url"]).data == contents


def test_unreadable_file_is_marked_failed_and_queue_continues(client, app):
    assert upload(client, b"not really a video", "broken.mp4").status_code == 201
    image = io.BytesIO()
    Image.new("RGB", (100, 100), "blue").save(image, "PNG")
    assert upload(client, image.getvalue(), "fine.png").status_code == 201
    process_all(app)
    states = {p["original_name"]: p["processing"] for p in client.get("/api/photos").json}
    assert states == {"broken.mp4": "failed", "fine.png": "done"}
    broken = next(p for p in client.get("/api/photos").json if p["original_name"] == "broken.mp4")
    assert client.get(broken["content_url"]).data == b"not really a video"


def test_deleting_forever_removes_thumbnails_and_copies(client, app, tmp_path):
    contents = make_video(tmp_path / "gone.mov", extra=("-f", "mov"))
    assert upload(client, contents, "gone.mov").status_code == 201
    process_all(app)
    video = client.get("/api/photos").json[0]
    media_root = app.config["MEDIA_ROOT"]
    assert (media_root / "_thumbs" / f"{video['id']}.jpg").exists()
    assert (media_root / "_streams" / f"{video['id']}.mp4").exists()
    assert client.delete(f"/api/photos/{video['id']}").status_code == 200
    assert client.delete(f"/api/trash/{video['id']}").status_code == 200
    assert not (media_root / "_thumbs" / f"{video['id']}.jpg").exists()
    assert not (media_root / "_streams" / f"{video['id']}.mp4").exists()


@pytest.mark.parametrize(("tags", "expected"), [
    ({"com.apple.quicktime.creationdate": "2026-10-17T20:15:30-0400",
      "creation_time": "2026-10-18T00:15:30.000000Z"}, "2026-10-17T20:15:30-04:00"),
    ({"creation_time": "1904-01-01T00:00:00.000000Z"}, None),
    ({}, None),
])
def test_video_capture_time_prefers_iphone_local_time(tags, expected):
    result = media.video_capture_time({"format": {"tags": tags}})
    assert (result.isoformat() if result else None) == expected


def test_small_h264_with_pcm_audio_still_gets_a_copy(tmp_path):
    source = tmp_path / "export.mov"
    make_video(source, codec="libx264", extra=("-maxrate", "1M", "-bufsize", "2M", "-f", "mov"))
    pcm = tmp_path / "export-pcm.mov"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(source), "-c:v", "copy", "-c:a", "pcm_s24le", str(pcm)],
        check=True,
    )
    assert not media.needs_stream_copy(media.probe(source), "mov")
    assert media.needs_stream_copy(media.probe(pcm), "mov")
