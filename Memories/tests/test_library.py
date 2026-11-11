from __future__ import annotations

import io
import sqlite3
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


def session_cookie_expiry(response):
    """The session cookie's expiry date, or None for a cookie that ends when the browser closes."""
    from http.cookies import SimpleCookie

    for header in response.headers.getlist("Set-Cookie"):
        cookie = SimpleCookie(header).get("session")
        if cookie is not None:
            expires = cookie["expires"]
            return datetime.strptime(expires, "%a, %d %b %Y %H:%M:%S GMT").replace(
                tzinfo=timezone.utc
            ) if expires else None
    raise AssertionError("no session cookie in the response")


def test_sign_in_lasts_30_days_and_renews_on_each_visit(client, app):
    response = establish_first_user(client)
    now = datetime.now(timezone.utc)
    assert session_cookie_expiry(response) - now > timedelta(days=29)
    client.post("/api/logout")

    response = client.post("/api/login", json={"username": "family", "password": "a-long-test-password"})
    assert session_cookie_expiry(response) - now > timedelta(days=29)
    # Opening the app again sends a fresh 30-day expiry.
    assert session_cookie_expiry(client.get("/api/photos")) - now > timedelta(days=29)


def test_existing_browser_session_is_upgraded_to_30_days(client, app):
    establish_first_user(client)
    with client.session_transaction() as old_session:
        old_session.permanent = False  # signed in before sessions had an expiry date
    response = client.get("/api/session")
    assert response.json["authenticated"] is True
    assert session_cookie_expiry(response) - datetime.now(timezone.utc) > timedelta(days=29)


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


def test_storage_reports_drive_library_trash_and_own_uploads(client, app):
    assert app.test_client().get("/api/storage").status_code == 401
    assert establish_first_user(client).status_code == 201
    assert upload(client, b"x" * 1000, "one.jpg").status_code == 201
    assert upload(client, b"y" * 500, "two.jpg").status_code == 201
    make_family_member(client)
    member = app.test_client()
    member.post("/api/login", json={"username": "mom", "password": "moms-long-password"})
    assert upload(member, b"z" * 200, "moms.jpg").status_code == 201
    trashed = next(p for p in client.get("/api/photos").json if p["original_name"] == "two.jpg")
    assert client.delete(f"/api/photos/{trashed['id']}").status_code == 200

    usage = client.get("/api/storage").json
    assert usage["drive"]["total_bytes"] > 0
    assert usage["drive"]["used_bytes"] + usage["drive"]["free_bytes"] <= usage["drive"]["total_bytes"]
    assert (usage["library_bytes"], usage["library_items"]) == (1200, 2)
    assert (usage["trash_bytes"], usage["trash_items"]) == (500, 1)
    assert (usage["my_bytes"], usage["my_items"]) == (1000, 1)


def create_invite_token(client):
    response = client.post("/api/admin/invites")
    assert response.status_code == 201
    return response.json["path"].removeprefix("/join/")


def test_invite_link_creates_one_account_only(client, app):
    assert establish_first_user(client).status_code == 201
    token = create_invite_token(client)
    assert len(client.get("/api/admin/invites").json) == 1

    guest = app.test_client()
    assert guest.get(f"/api/invites/{token}").json == {"valid": True}
    assert guest.post(
        f"/api/invites/{token}/accept", json={"username": "family", "password": "a-long-password-1"}
    ).status_code == 409
    assert guest.post(
        f"/api/invites/{token}/accept", json={"username": "jo", "password": "jos-long-password"}
    ).status_code == 201
    session = guest.get("/api/session").json
    assert session["username"] == "jo" and session["is_admin"] is False

    second = app.test_client()
    assert second.get(f"/api/invites/{token}").json == {"valid": False}
    assert second.post(
        f"/api/invites/{token}/accept", json={"username": "stranger", "password": "another-long-password"}
    ).status_code == 410
    assert client.get("/api/admin/invites").json == []


def test_expired_and_revoked_invites_cannot_be_used(client, app):
    import sqlite3

    assert establish_first_user(client).status_code == 201
    expired = create_invite_token(client)
    with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
        connection.execute("UPDATE invites SET expires_at = '2000-01-01T00:00:00Z'")
    revoked = create_invite_token(client)
    invite_id = client.get("/api/admin/invites").json[0]["id"]
    assert client.delete(f"/api/admin/invites/{invite_id}").status_code == 200

    guest = app.test_client()
    for token in (expired, revoked, "made-up-token"):
        assert guest.post(
            f"/api/invites/{token}/accept", json={"username": "jo", "password": "jos-long-password"}
        ).status_code == 410


def test_only_admin_can_create_invites(client, app):
    assert establish_first_user(client).status_code == 201
    make_family_member(client)
    member = app.test_client()
    member.post("/api/login", json={"username": "mom", "password": "moms-long-password"})
    assert member.post("/api/admin/invites").status_code == 403
    assert app.test_client().post("/api/admin/invites").status_code == 401


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
    assert [album["name"] for album in client.get("/api/albums").json] == [
        "Favorites", "Uploaded by iven", "Uploaded by mom",
    ]
    # Restarting doesn't add a second Favorites album.
    create_app()
    assert [album["name"] for album in client.get("/api/albums").json].count("Favorites") == 1


def albums_by_name(client):
    return {album["name"]: album for album in client.get("/api/albums").json}


def test_albums_start_with_favorites_and_one_uploaded_by_album_per_person(client, app):
    assert client.get("/api/albums").status_code == 401
    assert establish_first_user(client).status_code == 201
    make_family_member(client)
    member = app.test_client()
    member.post("/api/login", json={"username": "mom", "password": "moms-long-password"})
    upload(client, b"my photo", "mine.jpg")
    upload(member, b"mom photo", "moms.jpg")
    photos = {photo["original_name"]: photo["id"] for photo in client.get("/api/photos").json}

    albums = client.get("/api/albums").json
    assert [(album["kind"], album["name"]) for album in albums] == [
        ("favorites", "Favorites"),
        ("uploader", "Uploaded by family"),
        ("uploader", "Uploaded by mom"),
    ]
    by_name = {album["name"]: album for album in albums}
    assert by_name["Favorites"]["photo_ids"] == []
    assert by_name["Uploaded by family"]["photo_ids"] == [photos["mine.jpg"]]
    assert by_name["Uploaded by mom"]["photo_ids"] == [photos["moms.jpg"]]
    # Shared: the other account sees the same albums.
    assert member.get("/api/albums").json == albums


def test_favorites_and_uploaded_by_albums_cannot_be_renamed_or_deleted(client):
    establish_first_user(client)
    favorites = albums_by_name(client)["Favorites"]
    assert client.patch(f"/api/albums/{favorites['id']}", json={"name": "Best"}).status_code == 400
    assert client.delete(f"/api/albums/{favorites['id']}").status_code == 400
    assert "Favorites" in albums_by_name(client)
    # Uploaded-by albums have no album id, so there is nothing to rename or delete.
    assert albums_by_name(client)["Uploaded by family"]["id"] is None
    # A custom album can't take the Favorites name.
    assert client.post("/api/albums", json={"name": "favorites"}).status_code == 409


def test_shared_album_create_add_rename_remove_and_delete(client, app):
    establish_first_user(client)
    make_family_member(client)
    member = app.test_client()
    member.post("/api/login", json={"username": "mom", "password": "moms-long-password"})
    upload(client, b"beach photo", "beach.jpg")
    photo_id = client.get("/api/photos").json[0]["id"]

    assert client.post("/api/albums", json={"name": "  "}).status_code == 400
    created = client.post("/api/albums", json={"name": "Summer 2026"})
    assert created.status_code == 201
    album_id = created.json["id"]
    assert client.post("/api/albums", json={"name": "summer 2026"}).status_code == 409

    # Another family member can add to it, and adding twice keeps one copy.
    for _ in range(2):
        response = member.post(f"/api/albums/{album_id}/photos", json={"photo_id": photo_id})
        assert response.status_code == 200
    assert albums_by_name(client)["Summer 2026"]["photo_ids"] == [photo_id]
    assert member.post(f"/api/albums/{album_id}/photos", json={"photo_id": "nope"}).status_code == 404

    assert member.patch(f"/api/albums/{album_id}", json={"name": "Beach trip"}).status_code == 200
    assert "Beach trip" in albums_by_name(client)

    assert client.delete(f"/api/albums/{album_id}/photos/{photo_id}").status_code == 200
    assert albums_by_name(client)["Beach trip"]["photo_ids"] == []

    member.post(f"/api/albums/{album_id}/photos", json={"photo_id": photo_id})
    assert member.delete(f"/api/albums/{album_id}").status_code == 200
    assert "Beach trip" not in albums_by_name(client)
    # Deleting an album never deletes its photos.
    assert [photo["id"] for photo in client.get("/api/photos").json] == [photo_id]


def test_trashed_items_leave_albums_until_restored_and_are_removed_when_erased(client, app):
    establish_first_user(client)
    upload(client, b"favorite photo", "fav.jpg")
    photo_id = client.get("/api/photos").json[0]["id"]
    favorites = albums_by_name(client)["Favorites"]
    client.post(f"/api/albums/{favorites['id']}/photos", json={"photo_id": photo_id})

    client.delete(f"/api/photos/{photo_id}")
    albums = albums_by_name(client)
    assert albums["Favorites"]["photo_ids"] == []
    assert albums["Uploaded by family"]["photo_ids"] == []
    assert client.post(
        f"/api/albums/{favorites['id']}/photos", json={"photo_id": photo_id}
    ).status_code == 404

    client.post(f"/api/photos/{photo_id}/restore")
    assert albums_by_name(client)["Favorites"]["photo_ids"] == [photo_id]

    client.delete(f"/api/photos/{photo_id}")
    assert client.delete(f"/api/trash/{photo_id}").status_code == 200
    with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
        assert connection.execute("SELECT COUNT(*) FROM album_photos").fetchone()[0] == 0


def test_removed_account_keeps_uploaded_by_album_only_while_it_has_uploads(client, app):
    establish_first_user(client)
    make_family_member(client)
    make_family_member(client, "dad", "dads-long-password")
    member = app.test_client()
    member.post("/api/login", json={"username": "mom", "password": "moms-long-password"})
    upload(member, b"mom photo", "moms.jpg")
    accounts = {account["username"]: account["id"] for account in client.get("/api/admin/users").json}
    client.delete(f"/api/admin/users/{accounts['mom']}")
    client.delete(f"/api/admin/users/{accounts['dad']}")

    names = albums_by_name(client)
    assert "Uploaded by mom" in names
    assert "Uploaded by dad" not in names


def test_upload_into_album_adds_new_files_and_existing_ones_without_copies(client, app):
    establish_first_user(client)
    album_id = client.post("/api/albums", json={"name": "Camping"}).json["id"]
    upload(client, b"already here", "old.jpg")
    upload(client, b"was deleted", "deleted.jpg")
    photos = {photo["original_name"]: photo["id"] for photo in client.get("/api/photos").json}
    client.delete(f"/api/photos/{photos['deleted.jpg']}")

    def upload_to_album(contents, name, album=album_id):
        return client.post(
            "/api/photos",
            data={"file": (io.BytesIO(contents), name), "album_id": str(album)},
            content_type="multipart/form-data",
        )

    new = upload_to_album(b"brand new", "new.jpg")
    assert new.status_code == 201
    existing = upload_to_album(b"already here", "old-again.jpg")
    assert existing.status_code == 200
    assert existing.json == {"status": "already_in_library", "id": photos["old.jpg"], "restored": False}
    trashed = upload_to_album(b"was deleted", "deleted-again.jpg")
    assert trashed.json == {"status": "already_in_library", "id": photos["deleted.jpg"], "restored": True}

    assert client.get("/api/trash").json == []
    assert len(client.get("/api/photos").json) == 3  # no copies were made
    assert set(albums_by_name(client)["Camping"]["photo_ids"]) == {
        new.json["id"], photos["old.jpg"], photos["deleted.jpg"],
    }
    # Uploading the same album again changes nothing.
    assert upload_to_album(b"brand new", "new.jpg").status_code == 200
    assert len(albums_by_name(client)["Camping"]["photo_ids"]) == 3

    # Without an album, a duplicate is still refused as before.
    assert upload(client, b"brand new", "new.jpg").status_code == 409
    # An unknown album is refused before anything is stored.
    assert upload_to_album(b"another", "x.jpg", album=9999).status_code == 404
    assert upload_to_album(b"another", "x.jpg", album="abc").status_code == 404
    assert len(client.get("/api/photos").json) == 3


def in_all_photos(client):
    return {photo["original_name"]: photo["in_all_photos"] for photo in client.get("/api/photos").json}


def test_album_can_keep_its_items_out_of_all_photos(client, app):
    establish_first_user(client)
    upload(client, b"private photo", "private.jpg")
    upload(client, b"both albums", "both.jpg")
    upload(client, b"normal photo", "normal.jpg")
    photos = {photo["original_name"]: photo["id"] for photo in client.get("/api/photos").json}
    hidden = client.post("/api/albums", json={"name": "Just us"}).json["id"]
    shown = client.post("/api/albums", json={"name": "Trip"}).json["id"]
    favorites = albums_by_name(client)["Favorites"]["id"]
    for album, name in ((hidden, "private.jpg"), (hidden, "both.jpg"), (shown, "both.jpg"),
                        (favorites, "private.jpg")):
        client.post(f"/api/albums/{album}/photos", json={"photo_id": photos[name]})
    assert albums_by_name(client)["Just us"]["show_in_library"] is True  # on by default

    response = client.patch(f"/api/albums/{hidden}", json={"show_in_library": False})
    assert response.status_code == 200
    assert response.json == {"name": "Just us", "show_in_library": False}
    # Hiding wins when an item is also in a shown album.
    assert in_all_photos(client) == {"private.jpg": False, "both.jpg": False, "normal.jpg": True}
    albums = albums_by_name(client)
    assert albums["Just us"]["show_in_library"] is False
    assert len(albums["Just us"]["photo_ids"]) == 2  # still in the album itself
    assert albums["Trip"]["photo_ids"] == [photos["both.jpg"]]
    assert albums["Favorites"]["photo_ids"] == [photos["private.jpg"]]
    assert albums["Uploaded by family"]["photo_ids"] == [photos["normal.jpg"]]

    # Uploading an exact copy from All photos explains where the file is.
    response = upload(client, b"private photo", "private-again.jpg")
    assert response.status_code == 409
    assert 'in the album "Just us"' in response.json["error"]

    # Taking an item out of the hidden album, or turning the setting back on, shows it again.
    client.delete(f"/api/albums/{hidden}/photos/{photos['both.jpg']}")
    assert in_all_photos(client)["both.jpg"] is True
    client.patch(f"/api/albums/{hidden}", json={"show_in_library": True})
    assert all(in_all_photos(client).values())


def test_upload_into_hidden_album_never_shows_in_all_photos(client):
    establish_first_user(client)
    album_id = client.post("/api/albums", json={"name": "Surprise"}).json["id"]
    client.patch(f"/api/albums/{album_id}", json={"show_in_library": False})
    response = client.post(
        "/api/photos",
        data={"file": (io.BytesIO(b"gift photo"), "gift.jpg"), "album_id": str(album_id)},
        content_type="multipart/form-data",
    )
    assert response.status_code == 201
    assert in_all_photos(client) == {"gift.jpg": False}
    # Deleting the album brings its items back to All photos.
    client.delete(f"/api/albums/{album_id}")
    assert in_all_photos(client) == {"gift.jpg": True}


def test_show_in_all_photos_setting_rules(client):
    establish_first_user(client)
    favorites = albums_by_name(client)["Favorites"]["id"]
    assert client.patch(f"/api/albums/{favorites}", json={"show_in_library": False}).status_code == 400
    album_id = client.post("/api/albums", json={"name": "Trip"}).json["id"]
    assert client.patch(f"/api/albums/{album_id}", json={"show_in_library": "no"}).status_code == 400
    # Renaming leaves the setting alone, and changing the setting leaves the name alone.
    client.patch(f"/api/albums/{album_id}", json={"show_in_library": False})
    client.patch(f"/api/albums/{album_id}", json={"name": "Trip 2026"})
    album = albums_by_name(client)["Trip 2026"]
    assert album["show_in_library"] is False
