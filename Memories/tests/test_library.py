from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from PIL import ExifTags, Image

from werkzeug.security import generate_password_hash

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


def test_app_refuses_to_start_when_media_drive_is_not_mounted(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "db" / "library.sqlite3"))
    monkeypatch.setenv("MEDIA_MOUNT", str(tmp_path / "drive"))
    monkeypatch.setenv("MEDIA_ROOT", str(tmp_path / "drive" / "library"))
    with pytest.raises(RuntimeError, match="not mounted"):
        create_app()
    assert not (tmp_path / "drive").exists()


def test_media_root_must_be_on_the_media_drive(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "db" / "library.sqlite3"))
    monkeypatch.setenv("MEDIA_MOUNT", str(tmp_path / "drive"))
    monkeypatch.setenv("MEDIA_ROOT", str(tmp_path / "elsewhere"))
    monkeypatch.setattr("os.path.ismount", lambda path: True)
    with pytest.raises(RuntimeError, match="must be inside"):
        create_app()


def test_uploads_are_refused_if_media_drive_disappears(tmp_path, monkeypatch):
    drive = tmp_path / "drive"
    mounted = {"value": True}
    monkeypatch.setattr("os.path.ismount", lambda path: mounted["value"] and Path(path) == drive)
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "db" / "library.sqlite3"))
    monkeypatch.setenv("MEDIA_MOUNT", str(drive))
    monkeypatch.setenv("MEDIA_ROOT", str(drive / "library"))
    client = create_app().test_client()
    assert establish_first_user(client).status_code == 201

    mounted["value"] = False
    response = upload(client, b"sample image bytes", "beach.jpg")
    assert response.status_code == 503
    assert list((drive / "library").iterdir()) == []


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
    assert photo["taken_at"].endswith("Z")
    assert len(list(app.config["MEDIA_ROOT"].rglob("*.jpg"))) == 1

    assert client.delete(f"/api/photos/{photo['id']}").status_code == 200
    assert client.get("/api/photos").json == []
    assert len(client.get("/api/trash").json) == 1
    assert client.get(photo["content_url"]).data == b"sample image bytes"
    assert client.post(f"/api/photos/{photo['id']}/restore").status_code == 200
    assert len(client.get("/api/photos").json) == 1


def test_duplicate_of_trashed_file_points_to_restore(client):
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
    assert duplicate.json["code"] == "in_trash"
    assert duplicate.json["photo_id"] == photo_id
    assert duplicate.json["error"] == "one.jpg was recently deleted."

    assert client.post(f"/api/photos/{photo_id}/restore").status_code == 200
    again = client.post(
        "/api/photos",
        data={"file": (io.BytesIO(contents), "copy.jpg")},
        content_type="multipart/form-data",
    )
    assert again.status_code == 409
    assert again.json["code"] == "duplicate"


def test_photo_capture_date_is_used_for_library_path(client, app):
    assert establish_first_user(client).status_code == 201
    exif = Image.Exif()
    exif[306] = "2014:05:20 12:30:45"
    exif.get_ifd(ExifTags.IFD.Exif)[36880] = "-04:00"
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
    assert photo["taken_at"] == "2014-05-20T16:30:45Z"
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


def upload(client, contents, name):
    return client.post(
        "/api/photos",
        data={"file": (io.BytesIO(contents), name)},
        content_type="multipart/form-data",
    )


def test_heic_photo_gets_capture_date_and_jpeg_display_copy(client, app):
    import pillow_heif

    assert establish_first_user(client).status_code == 201
    exif = Image.Exif()
    exif.get_ifd(ExifTags.IFD.Exif)[36867] = "2021:12:25 08:15:00"
    exif.get_ifd(ExifTags.IFD.Exif)[36881] = "-05:00"
    heic = pillow_heif.from_pillow(Image.new("RGB", (64, 64), "blue"))
    image_bytes = io.BytesIO()
    heic.save(image_bytes, exif=exif.tobytes())

    assert upload(client, image_bytes.getvalue(), "IMG_0001.HEIC").status_code == 201
    photo = client.get("/api/photos").json[0]
    assert photo["taken_at"] == "2021-12-25T13:15:00Z"
    assert photo["content_type"] == "image/heic"
    assert (app.config["MEDIA_ROOT"] / "2021" / "12").is_dir()

    display = client.get(photo["content_url"])
    assert display.mimetype == "image/jpeg"
    assert display.data[:2] == b"\xff\xd8"
    original = client.get(photo["original_url"])
    assert original.data == image_bytes.getvalue()
    assert "IMG_0001.HEIC" in original.headers["Content-Disposition"]


def make_family_member(client, username="mom", password="moms-long-password"):
    response = client.post(
        "/api/admin/users", json={"username": username, "password": password}
    )
    assert response.status_code == 201
    return next(u for u in client.get("/api/admin/users").json if u["username"] == username)


def test_first_account_is_the_only_admin(client, app):
    assert establish_first_user(client).status_code == 201
    assert client.get("/api/session").json["is_admin"] is True
    make_family_member(client)

    member = app.test_client()
    assert member.post(
        "/api/login", json={"username": "mom", "password": "moms-long-password"}
    ).status_code == 200
    assert member.get("/api/session").json["is_admin"] is False
    assert member.get("/api/admin/users").status_code == 403
    assert member.post(
        "/api/admin/users", json={"username": "kid", "password": "kids-long-password"}
    ).status_code == 403


def test_admin_resets_password_and_signs_out_old_sessions(client, app):
    assert establish_first_user(client).status_code == 201
    mom = make_family_member(client)
    member = app.test_client()
    member.post("/api/login", json={"username": "mom", "password": "moms-long-password"})

    assert client.post(
        f"/api/admin/users/{mom['id']}/password", json={"password": "short"}
    ).status_code == 400
    assert client.post(
        f"/api/admin/users/{mom['id']}/password", json={"password": "a-brand-new-password"}
    ).status_code == 200
    assert member.get("/api/photos").status_code == 401
    assert member.post(
        "/api/login", json={"username": "mom", "password": "moms-long-password"}
    ).status_code == 401
    assert member.post(
        "/api/login", json={"username": "mom", "password": "a-brand-new-password"}
    ).status_code == 200


def test_member_changes_own_password_and_other_devices_sign_out(client, app):
    assert establish_first_user(client).status_code == 201
    make_family_member(client)
    phone, laptop = app.test_client(), app.test_client()
    for device in (phone, laptop):
        device.post("/api/login", json={"username": "mom", "password": "moms-long-password"})

    assert phone.post(
        "/api/account/password",
        json={"current_password": "wrong-password", "new_password": "a-brand-new-password"},
    ).status_code == 403
    assert phone.post(
        "/api/account/password",
        json={"current_password": "moms-long-password", "new_password": "short"},
    ).status_code == 400
    assert phone.post(
        "/api/account/password",
        json={"current_password": "moms-long-password", "new_password": "a-brand-new-password"},
    ).status_code == 200

    assert phone.get("/api/photos").status_code == 200
    assert laptop.get("/api/photos").status_code == 401
    assert laptop.post(
        "/api/login", json={"username": "mom", "password": "a-brand-new-password"}
    ).status_code == 200


def test_member_changes_own_username_and_keeps_photo_credit(client, app):
    assert establish_first_user(client).status_code == 201
    make_family_member(client)
    member = app.test_client()
    member.post("/api/login", json={"username": "mom", "password": "moms-long-password"})
    assert upload(member, b"mom's photo", "garden.jpg").status_code == 201

    assert member.post(
        "/api/account/username", json={"current_password": "nope", "username": "mama"}
    ).status_code == 403
    assert member.post(
        "/api/account/username",
        json={"current_password": "moms-long-password", "username": "FAMILY"},
    ).status_code == 409
    assert member.post(
        "/api/account/username",
        json={"current_password": "moms-long-password", "username": "mama"},
    ).status_code == 200

    assert member.get("/api/session").json["username"] == "mama"
    assert client.get("/api/photos").json[0]["uploaded_by"] == "mama"
    assert app.test_client().post(
        "/api/login", json={"username": "mama", "password": "moms-long-password"}
    ).status_code == 200


def test_only_admin_can_rename_other_accounts(client, app):
    assert establish_first_user(client).status_code == 201
    mom = make_family_member(client)
    member = app.test_client()
    member.post("/api/login", json={"username": "mom", "password": "moms-long-password"})

    assert member.post(
        f"/api/admin/users/{mom['id']}/username", json={"username": "mama"}
    ).status_code == 403
    assert client.post(
        f"/api/admin/users/{mom['id']}/username", json={"username": "x"}
    ).status_code == 400
    assert client.post(
        f"/api/admin/users/{mom['id']}/username", json={"username": "ma"}
    ).status_code == 200
    assert client.post(
        f"/api/admin/users/{mom['id']}/username", json={"username": "mama"}
    ).status_code == 200
    assert member.get("/api/session").json["username"] == "mama"


def test_rename_user_command(app):
    import builtins

    client = app.test_client()
    assert establish_first_user(client).status_code == 201
    answers = iter(["family", "admin-dad"])
    original_input = builtins.input
    builtins.input = lambda prompt="": next(answers)
    try:
        result = app.test_cli_runner().invoke(args=["rename-user"])
    finally:
        builtins.input = original_input
    assert "Renamed family to admin-dad." in result.output
    assert client.get("/api/session").json["username"] == "admin-dad"


def test_removed_account_keeps_photo_credit_but_cannot_sign_in(client, app):
    assert establish_first_user(client).status_code == 201
    mom = make_family_member(client)
    member = app.test_client()
    member.post("/api/login", json={"username": "mom", "password": "moms-long-password"})
    assert upload(member, b"mom's photo", "beach.jpg").status_code == 201

    me = next(u for u in client.get("/api/admin/users").json if u["is_admin"])
    assert client.delete(f"/api/admin/users/{me['id']}").status_code == 400
    assert client.delete(f"/api/admin/users/{mom['id']}").status_code == 200
    assert member.get("/api/photos").status_code == 401
    assert member.post(
        "/api/login", json={"username": "mom", "password": "moms-long-password"}
    ).status_code == 401
    assert client.get("/api/photos").json[0]["uploaded_by"] == "mom"


def test_only_admin_can_delete_from_trash_early(client, app):
    assert establish_first_user(client).status_code == 201
    make_family_member(client)
    member = app.test_client()
    member.post("/api/login", json={"username": "mom", "password": "moms-long-password"})
    assert upload(member, b"blurry photo", "blurry.jpg").status_code == 201
    photo_id = member.get("/api/photos").json[0]["id"]

    assert client.delete(f"/api/trash/{photo_id}").status_code == 404
    assert member.delete(f"/api/photos/{photo_id}").status_code == 200
    assert member.delete(f"/api/trash/{photo_id}").status_code == 403
    assert client.delete(f"/api/trash/{photo_id}").status_code == 200
    assert client.get("/api/trash").json == []
    assert not list(app.config["MEDIA_ROOT"].rglob("*.jpg"))


def test_built_frontend_is_served_alongside_the_api(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<title>Memories</title>")
    (dist / "assets" / "app.js").write_text("console.log('hi')")
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "library.sqlite3"))
    monkeypatch.setenv("MEDIA_ROOT", str(tmp_path / "media"))
    monkeypatch.setenv("FRONTEND_DIST", str(dist))
    client = create_app().test_client()

    assert b"Memories" in client.get("/").data
    assert b"Memories" in client.get("/trash").data
    assert client.get("/assets/app.js").data == b"console.log('hi')"
    missing_api = client.get("/api/nothing-here")
    assert missing_api.status_code == 404
    assert "error" in missing_api.json


def test_existing_library_is_upgraded_and_first_account_becomes_admin(tmp_path, monkeypatch):
    import sqlite3

    database_path = tmp_path / "library.sqlite3"
    with sqlite3.connect(database_path) as connection:
        connection.executescript("""
            CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE photos (id TEXT PRIMARY KEY, original_name TEXT NOT NULL,
                relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL UNIQUE,
                content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, taken_at TEXT NOT NULL,
                uploaded_at TEXT NOT NULL, uploaded_by INTEGER NOT NULL REFERENCES users(id),
                deleted_at TEXT);
        """)
        for username in ("iven", "mom"):
            connection.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, generate_password_hash("a-long-test-password"), "2026-10-01T00:00:00Z"),
            )
    monkeypatch.setenv("DATABASE_PATH", str(database_path))
    monkeypatch.setenv("MEDIA_ROOT", str(tmp_path / "media"))
    client = create_app().test_client()

    client.post("/api/login", json={"username": "iven", "password": "a-long-test-password"})
    assert client.get("/api/session").json["is_admin"] is True
    users = {u["username"]: u["is_admin"] for u in client.get("/api/admin/users").json}
    assert users == {"iven": True, "mom": False}
