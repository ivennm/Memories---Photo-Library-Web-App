from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone

import pytest
from PIL import Image

from backend.app import create_app, iso_timestamp


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
    return app.test_client()


def establish_first_user(client):
    return client.post(
        "/api/first-user",
        json={"username": "family", "password": "a-long-test-password"},
    )


def test_first_user_can_upload_list_and_restore_photo(client, app):
    assert client.get("/api/session").json == {
        "authenticated": False,
        "can_create_first_user": True,
    }
    assert establish_first_user(client).status_code == 201

    uploaded = client.post(
        "/api/photos",
        data={"file": (io.BytesIO(b"sample image bytes"), "summer.jpg")},
        content_type="multipart/form-data",
    )
    assert uploaded.status_code == 201

    photo = client.get("/api/photos").json[0]
    assert photo["original_name"] == "summer.jpg"
    assert photo["uploaded_by"] == "family"
    assert photo["taken_at"] == photo["uploaded_at"]
    stored_file = app.config["MEDIA_ROOT"] / photo["taken_at"][:4] / photo["taken_at"][5:7]
    assert len(list(stored_file.iterdir())) == 1

    assert client.delete(f"/api/photos/{photo['id']}").status_code == 200
    assert client.get("/api/photos").json == []
    assert len(client.get("/api/trash").json) == 1
    assert client.post(f"/api/photos/{photo['id']}/restore").status_code == 200
    assert len(client.get("/api/photos").json) == 1


def test_duplicate_file_is_rejected_even_after_being_trashed(client):
    assert establish_first_user(client).status_code == 201
    contents = b"same exact file"
    first = client.post(
        "/api/photos",
        data={"file": (io.BytesIO(contents), "one.jpg")},
        content_type="multipart/form-data",
    )
    assert first.status_code == 201
    photo_id = client.get("/api/photos").json[0]["id"]
    assert client.delete(f"/api/photos/{photo_id}").status_code == 200
    duplicate = client.post(
        "/api/photos",
        data={"file": (io.BytesIO(contents), "copy.jpg")},
        content_type="multipart/form-data",
    )
    assert duplicate.status_code == 409


def test_photo_capture_date_is_used_for_library_path(client, app):
    assert establish_first_user(client).status_code == 201
    exif = Image.Exif()
    exif[306] = "2014:05:20 12:30:45"
    image_bytes = io.BytesIO()
    Image.new("RGB", (2, 2), "red").save(image_bytes, format="JPEG", exif=exif)
    image_bytes.seek(0)

    uploaded = client.post(
        "/api/photos",
        data={"file": (image_bytes, "old-photo.jpg")},
        content_type="multipart/form-data",
    )
    assert uploaded.status_code == 201
    photo = client.get("/api/photos").json[0]
    assert photo["taken_at"].startswith("2014-05-20T12:30:45")
    assert (app.config["MEDIA_ROOT"] / "2014" / "05").is_dir()


def test_expired_trash_is_permanently_purged(client, app):
    assert establish_first_user(client).status_code == 201
    assert client.post(
        "/api/photos",
        data={"file": (io.BytesIO(b"old media"), "old.jpg")},
        content_type="multipart/form-data",
    ).status_code == 201
    photo = client.get("/api/photos").json[0]
    client.delete(f"/api/photos/{photo['id']}")

    with app.app_context():
        from flask import current_app
        import sqlite3

        with sqlite3.connect(current_app.config["DATABASE_PATH"]) as connection:
            connection.execute(
                "UPDATE photos SET deleted_at = ? WHERE id = ?",
                (iso_timestamp(datetime.now(timezone.utc) - timedelta(days=31)), photo["id"]),
            )

    result = app.test_cli_runner().invoke(args=["purge-expired"])
    assert result.exit_code == 0
    assert "Permanently deleted 1 expired item(s)." in result.output
    assert client.get("/api/trash").json == []
    assert not list(app.config["MEDIA_ROOT"].rglob("*.jpg"))


def test_library_requires_sign_in(client):
    assert client.get("/api/photos").status_code == 401
    assert client.post(
        "/api/photos",
        data={"file": (io.BytesIO(b"private"), "private.jpg")},
        content_type="multipart/form-data",
    ).status_code == 401


def test_first_account_setup_closes_after_first_user(client):
    assert establish_first_user(client).status_code == 201
    second = client.post(
        "/api/first-user",
        json={"username": "another", "password": "another-long-password"},
    )
    assert second.status_code == 409
