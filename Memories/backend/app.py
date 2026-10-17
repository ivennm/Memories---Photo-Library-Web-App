from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
import secrets
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pillow_heif
from flask import Flask, abort, g, jsonify, request, send_file, send_from_directory, session
from PIL import ExifTags, Image, ImageOps
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

pillow_heif.register_heif_opener()
mimetypes.add_type("image/heic", ".heic")
mimetypes.add_type("image/heif", ".heif")

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp",
    "mp4", "mov", "m4v", "webm", "mkv", "avi",
}
VIDEO_EXTENSIONS = {"mp4", "mov", "m4v", "webm", "mkv", "avi"}
# Formats most browsers outside Safari cannot display; a JPEG copy is shown instead.
DISPLAY_COPY_EXTENSIONS = {"heic", "heif", "tif", "tiff"}
DISPLAY_COPY_MAX_EDGE = 2560
DISPLAY_COPY_DIRECTORY = "_previews"
TRASH_RETENTION = timedelta(days=30)
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    removed_at TEXT,
    session_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    display_path TEXT,
    sha256 TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    taken_at TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS photos_timeline
    ON photos(deleted_at, taken_at DESC, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS photos_uploader ON photos(uploaded_by);
"""
# Columns added after the first release, applied to existing databases on startup.
ADDED_COLUMNS = {
    "users": {
        "is_admin": "INTEGER NOT NULL DEFAULT 0",
        "removed_at": "TEXT",
        "session_version": "INTEGER NOT NULL DEFAULT 0",
    },
    "photos": {"display_path": "TEXT"},
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso_timestamp(value: datetime) -> str:
    """Every stored timestamp is UTC in the form 2026-10-09T15:04:05Z."""
    if value.tzinfo is None:
        value = value.astimezone()
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_exif_datetime(raw_date: Any, raw_offset: Any) -> datetime | None:
    """Return a timezone-aware capture time from EXIF date and offset tags.

    iPhones record the offset; when it is missing the server's local timezone is assumed.
    """
    try:
        captured = datetime.strptime(str(raw_date).strip("\x00 "), "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None
    if raw_offset:
        try:
            offset = datetime.strptime(str(raw_offset).strip("\x00 "), "%z").tzinfo
            return captured.replace(tzinfo=offset)
        except ValueError:
            pass
    return captured.astimezone()


def credential_error(username: str | None, password: str | None) -> str | None:
    if username is not None and not 2 <= len(username) <= 40:
        return "Username must be 2 to 40 characters."
    if password is not None and len(password) < 12:
        return "Password must be at least 12 characters."
    if password is not None and len(password) > 1024:
        return "Password must be no more than 1024 characters."
    return None


def migrate(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA)
    for table, columns in ADDED_COLUMNS.items():
        existing = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        for name, definition in columns.items():
            if name not in existing:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
    # Libraries created before the admin role existed: the first account becomes admin.
    if not connection.execute("SELECT 1 FROM users WHERE is_admin = 1").fetchone():
        connection.execute(
            "UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)"
        )


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
    app.config["DATABASE_PATH"] = Path(
        os.environ.get("DATABASE_PATH", "./data/photolibrary.sqlite3")
    ).resolve()
    app.config["MEDIA_ROOT"] = Path(
        os.environ.get("MEDIA_ROOT", "./data/library")
    ).resolve()
    # Mount point of the dedicated media drive. When set, media is only written while that
    # drive is mounted, so an unmounted drive can't silently fill the OS disk instead.
    media_mount = os.environ.get("MEDIA_MOUNT")
    app.config["MEDIA_MOUNT"] = Path(media_mount).resolve() if media_mount else None
    app.config["FRONTEND_DIST"] = Path(
        os.environ.get("FRONTEND_DIST", Path(__file__).resolve().parent.parent / "frontend" / "dist")
    ).resolve()
    max_upload_mb = int(os.environ.get("MAX_UPLOAD_MB", "2048"))
    app.config["MAX_CONTENT_LENGTH"] = max_upload_mb * 1024 * 1024
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_SECURE"] = (
        os.environ.get("SESSION_COOKIE_SECURE", "false").lower() == "true"
    )

    if os.environ.get("APP_ENV") == "production" and not os.environ.get("SECRET_KEY"):
        raise RuntimeError("Set SECRET_KEY to a persistent random value in production.")

    media_root: Path = app.config["MEDIA_ROOT"]
    media_mount: Path | None = app.config["MEDIA_MOUNT"]
    if media_mount is not None:
        if not media_root.is_relative_to(media_mount):
            raise RuntimeError(f"MEDIA_ROOT ({media_root}) must be inside MEDIA_MOUNT ({media_mount}).")
        if not os.path.ismount(media_mount):
            raise RuntimeError(f"The media drive is not mounted at {media_mount}.")

    def media_drive_available() -> bool:
        return media_mount is None or os.path.ismount(media_mount)

    app.config["DATABASE_PATH"].parent.mkdir(parents=True, exist_ok=True)
    media_root.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        migrate(connection)

    def database() -> sqlite3.Connection:
        if "database" not in g:
            connection = sqlite3.connect(app.config["DATABASE_PATH"])
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            g.database = connection
        return g.database

    @app.teardown_appcontext
    def close_database(_error: BaseException | None = None) -> None:
        connection = g.pop("database", None)
        if connection is not None:
            connection.close()

    def media_path(relative_path: str) -> Path | None:
        path = (media_root / relative_path).resolve()
        return path if path.is_relative_to(media_root) else None

    def sign_in(user_id: int, session_version: int) -> None:
        session.clear()
        session["user_id"] = user_id
        session["session_version"] = session_version

    def current_user() -> sqlite3.Row | None:
        user_id = session.get("user_id")
        if user_id is None:
            return None
        user = database().execute(
            """
            SELECT id, username, is_admin, session_version FROM users
            WHERE id = ? AND removed_at IS NULL
            """,
            (user_id,),
        ).fetchone()
        # Password resets and account removal bump session_version, signing out old sessions.
        if user is None or user["session_version"] != session.get("session_version"):
            session.clear()
            return None
        return user

    def require_user() -> sqlite3.Row:
        user = current_user()
        if user is None:
            abort(401)
        return user

    def require_admin() -> sqlite3.Row:
        user = require_user()
        if not user["is_admin"]:
            abort(403)
        return user

    def request_json() -> dict[str, Any]:
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else {}

    def photo_json(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "original_name": row["original_name"],
            "content_type": row["content_type"],
            "size_bytes": row["size_bytes"],
            "taken_at": row["taken_at"],
            "uploaded_at": row["uploaded_at"],
            "uploaded_by": row["username"],
            "deleted_at": row["deleted_at"],
            "content_url": f"/api/photos/{row['id']}/content",
            "original_url": f"/api/photos/{row['id']}/original",
        }

    def erase_photo(connection: sqlite3.Connection, row: sqlite3.Row) -> None:
        for relative_path in (row["relative_path"], row["display_path"]):
            if relative_path and (path := media_path(relative_path)) is not None:
                path.unlink(missing_ok=True)
        connection.execute("DELETE FROM photos WHERE id = ?", (row["id"],))

    def duplicate_response(row: sqlite3.Row) -> tuple[Any, int]:
        if row["deleted_at"] is not None:
            return jsonify({
                "error": f"{row['original_name']} was recently deleted.",
                "code": "in_trash",
                "photo_id": row["id"],
            }), 409
        return jsonify({
            "error": "This exact file is already in the library.",
            "code": "duplicate",
            "photo_id": row["id"],
        }), 409

    @app.errorhandler(HTTPException)
    def api_error(error: HTTPException) -> Any:
        if not request.path.startswith("/api/"):
            return error
        if error.code == 413:
            message = f"Upload exceeds the {max_upload_mb} MB limit."
        else:
            message = error.description or error.name
        return jsonify({"error": message}), error.code

    @app.get("/api/health")
    def health() -> tuple[dict[str, str], int]:
        return {"status": "ok"}, 200

    @app.get("/api/session")
    def session_info() -> tuple[Any, int]:
        user = current_user()
        user_count = database().execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if user is None:
            return jsonify({
                "authenticated": False,
                "can_create_first_user": user_count == 0,
            }), 200
        return jsonify({
            "authenticated": True,
            "username": user["username"],
            "is_admin": bool(user["is_admin"]),
            "can_create_first_user": user_count == 0,
        }), 200

    @app.post("/api/login")
    def login() -> tuple[Any, int]:
        data = request_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        user = database().execute(
            """
            SELECT id, username, password_hash, session_version FROM users
            WHERE username = ? AND removed_at IS NULL
            """,
            (username,),
        ).fetchone()
        if user is None or not check_password_hash(user["password_hash"], password):
            return jsonify({"error": "Invalid username or password."}), 401
        sign_in(user["id"], user["session_version"])
        return jsonify({"username": user["username"]}), 200

    @app.post("/api/logout")
    def logout() -> tuple[Any, int]:
        session.clear()
        return jsonify({"status": "ok"}), 200

    @app.post("/api/first-user")
    def create_first_user() -> tuple[Any, int]:
        data = request_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        if error := credential_error(username, password):
            return jsonify({"error": error}), 400
        connection = database()
        try:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                connection.rollback()
                return jsonify({"error": "The first account has already been created."}), 409
            cursor = connection.execute(
                """
                INSERT INTO users (username, password_hash, created_at, is_admin)
                VALUES (?, ?, ?, 1)
                """,
                (username, generate_password_hash(password), iso_timestamp(utc_now())),
            )
            connection.commit()
        except sqlite3.IntegrityError:
            connection.rollback()
            return jsonify({"error": "That username is already in use."}), 409
        sign_in(cursor.lastrowid, 0)
        return jsonify({"username": username}), 201

    @app.get("/api/photos")
    def list_photos() -> tuple[Any, int]:
        require_user()
        rows = database().execute(
            """
            SELECT photos.*, users.username
            FROM photos JOIN users ON users.id = photos.uploaded_by
            WHERE photos.deleted_at IS NULL
            ORDER BY photos.taken_at DESC, photos.uploaded_at DESC
            """
        ).fetchall()
        return jsonify([photo_json(row) for row in rows]), 200

    @app.get("/api/trash")
    def list_trash() -> tuple[Any, int]:
        require_user()
        rows = database().execute(
            """
            SELECT photos.*, users.username
            FROM photos JOIN users ON users.id = photos.uploaded_by
            WHERE photos.deleted_at IS NOT NULL
            ORDER BY photos.deleted_at DESC
            """
        ).fetchall()
        return jsonify([photo_json(row) for row in rows]), 200

    @app.post("/api/photos")
    def upload_photo() -> tuple[Any, int]:
        user = require_user()
        upload = request.files.get("file")
        if upload is None or not upload.filename:
            return jsonify({"error": "Choose a photo or video to upload."}), 400
        safe_name = secure_filename(upload.filename)
        extension = Path(safe_name).suffix.lower().lstrip(".")
        if extension not in ALLOWED_EXTENSIONS:
            return jsonify({"error": "This photo or video file type is not supported."}), 400
        if not media_drive_available():
            logger.error("Upload refused: media drive is not mounted at %s", media_mount)
            return jsonify({"error": "The photo library drive is unavailable. Try again later."}), 503

        photo_id = uuid.uuid4().hex
        temp_path = media_root / f".upload-{uuid.uuid4().hex}.tmp"
        digest = hashlib.sha256()
        size_bytes = 0
        created_files: list[Path] = []
        committed = False
        try:
            with temp_path.open("xb") as output:
                while chunk := upload.stream.read(1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
                    size_bytes += len(chunk)
            if size_bytes == 0:
                return jsonify({"error": "The selected file is empty."}), 400
            checksum = digest.hexdigest()
            connection = database()
            find_existing = (
                "SELECT id, original_name, deleted_at FROM photos WHERE sha256 = ?"
            )
            if existing := connection.execute(find_existing, (checksum,)).fetchone():
                return duplicate_response(existing)

            uploaded_at = utc_now()
            taken_at = uploaded_at.astimezone()
            display_path: Path | None = None
            if extension not in VIDEO_EXTENSIONS:
                try:
                    with Image.open(temp_path) as image:
                        exif = image.getexif()
                        exif_ifd = exif.get_ifd(ExifTags.IFD.Exif)
                        for raw_date, raw_offset in (
                            (exif_ifd.get(36867), exif_ifd.get(36881)),  # DateTimeOriginal
                            (exif_ifd.get(36868), exif_ifd.get(36882)),  # DateTimeDigitized
                            (exif.get(306), exif_ifd.get(36880)),  # DateTime
                        ):
                            if raw_date and (parsed := parse_exif_datetime(raw_date, raw_offset)):
                                taken_at = parsed
                                break
                        if extension in DISPLAY_COPY_EXTENSIONS:
                            display_image = ImageOps.exif_transpose(image).convert("RGB")
                            display_image.thumbnail((DISPLAY_COPY_MAX_EDGE, DISPLAY_COPY_MAX_EDGE))
                            display_path = Path(DISPLAY_COPY_DIRECTORY, f"{photo_id}.jpg")
                            display_file = media_root / display_path
                            display_file.parent.mkdir(parents=True, exist_ok=True)
                            created_files.append(display_file)
                            display_image.save(display_file, "JPEG", quality=85)
                except (OSError, ValueError, KeyError, SyntaxError):
                    logger.warning("Could not read image data from %s", safe_name, exc_info=True)

            # Folders use the wall-clock date where the photo was taken.
            relative_path = Path(
                taken_at.strftime("%Y"),
                taken_at.strftime("%m"),
                f"{uuid.uuid4().hex}.{extension}",
            )
            destination = media_root / relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            created_files.append(destination)
            os.replace(temp_path, destination)
            content_type = mimetypes.guess_type(safe_name)[0] or "application/octet-stream"
            cursor = connection.execute(
                """
                INSERT INTO photos
                (id, original_name, relative_path, display_path, sha256, content_type,
                 size_bytes, taken_at, uploaded_at, uploaded_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(sha256) DO NOTHING
                """,
                (
                    photo_id,
                    safe_name,
                    relative_path.as_posix(),
                    display_path.as_posix() if display_path else None,
                    checksum,
                    content_type,
                    size_bytes,
                    iso_timestamp(taken_at),
                    iso_timestamp(uploaded_at),
                    user["id"],
                )
            )
            if cursor.rowcount == 0:
                connection.rollback()
                return duplicate_response(connection.execute(find_existing, (checksum,)).fetchone())
            connection.commit()
            committed = True
            return jsonify({"status": "uploaded", "id": photo_id}), 201
        finally:
            temp_path.unlink(missing_ok=True)
            if not committed:
                for path in created_files:
                    path.unlink(missing_ok=True)

    def photo_file(photo_id: str, *, original: bool) -> Any:
        require_user()
        row = database().execute(
            "SELECT * FROM photos WHERE id = ?", (photo_id,)
        ).fetchone()
        if row is None:
            abort(404)
        use_display_copy = not original and row["display_path"]
        path = media_path(row["display_path"] if use_display_copy else row["relative_path"])
        if path is None or not path.is_file():
            abort(404)
        if original:
            return send_file(
                path, mimetype=row["content_type"], conditional=True,
                as_attachment=True, download_name=row["original_name"],
            )
        return send_file(
            path, mimetype="image/jpeg" if use_display_copy else row["content_type"],
            conditional=True,
        )

    @app.get("/api/photos/<photo_id>/content")
    def photo_content(photo_id: str) -> Any:
        return photo_file(photo_id, original=False)

    @app.get("/api/photos/<photo_id>/original")
    def photo_original(photo_id: str) -> Any:
        return photo_file(photo_id, original=True)

    @app.delete("/api/photos/<photo_id>")
    def delete_photo(photo_id: str) -> tuple[Any, int]:
        require_user()
        cursor = database().execute(
            "UPDATE photos SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
            (iso_timestamp(utc_now()), photo_id),
        )
        database().commit()
        if cursor.rowcount == 0:
            return jsonify({"error": "Photo not found."}), 404
        return jsonify({"status": "in_trash"}), 200

    @app.post("/api/photos/<photo_id>/restore")
    def restore_photo(photo_id: str) -> tuple[Any, int]:
        require_user()
        cursor = database().execute(
            "UPDATE photos SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL",
            (photo_id,),
        )
        database().commit()
        if cursor.rowcount == 0:
            return jsonify({"error": "Photo not found in trash."}), 404
        return jsonify({"status": "restored"}), 200

    @app.delete("/api/trash/<photo_id>")
    def delete_permanently(photo_id: str) -> tuple[Any, int]:
        require_admin()
        connection = database()
        row = connection.execute(
            "SELECT * FROM photos WHERE id = ? AND deleted_at IS NOT NULL", (photo_id,)
        ).fetchone()
        if row is None:
            return jsonify({"error": "Photo not found in trash."}), 404
        if not media_drive_available():
            return jsonify({"error": "The photo library drive is unavailable. Try again later."}), 503
        erase_photo(connection, row)
        connection.commit()
        return jsonify({"status": "deleted"}), 200

    @app.get("/api/admin/users")
    def list_users() -> tuple[Any, int]:
        require_admin()
        rows = database().execute(
            """
            SELECT users.id, users.username, users.is_admin, users.created_at,
                   users.removed_at, COUNT(photos.id) AS photo_count
            FROM users LEFT JOIN photos ON photos.uploaded_by = users.id
            GROUP BY users.id
            ORDER BY users.removed_at IS NOT NULL, users.username COLLATE NOCASE
            """
        ).fetchall()
        return jsonify([
            {
                "id": row["id"],
                "username": row["username"],
                "is_admin": bool(row["is_admin"]),
                "created_at": row["created_at"],
                "removed_at": row["removed_at"],
                "photo_count": row["photo_count"],
            }
            for row in rows
        ]), 200

    @app.post("/api/admin/users")
    def admin_create_user() -> tuple[Any, int]:
        require_admin()
        data = request_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        if error := credential_error(username, password):
            return jsonify({"error": error}), 400
        connection = database()
        try:
            connection.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, generate_password_hash(password), iso_timestamp(utc_now())),
            )
            connection.commit()
        except sqlite3.IntegrityError:
            return jsonify({"error": "That username is already in use."}), 409
        return jsonify({"username": username}), 201

    @app.post("/api/admin/users/<int:user_id>/password")
    def admin_reset_password(user_id: int) -> tuple[Any, int]:
        admin = require_admin()
        password = str(request_json().get("password", ""))
        if error := credential_error(None, password):
            return jsonify({"error": error}), 400
        connection = database()
        cursor = connection.execute(
            """
            UPDATE users SET password_hash = ?, session_version = session_version + 1
            WHERE id = ? AND removed_at IS NULL
            """,
            (generate_password_hash(password), user_id),
        )
        connection.commit()
        if cursor.rowcount == 0:
            return jsonify({"error": "Account not found."}), 404
        if user_id == admin["id"]:
            session["session_version"] = admin["session_version"] + 1
        return jsonify({"status": "password_reset"}), 200

    def rename_user(user_id: int, username: str) -> tuple[Any, int]:
        if error := credential_error(username, None):
            return jsonify({"error": error}), 400
        connection = database()
        try:
            cursor = connection.execute(
                "UPDATE users SET username = ? WHERE id = ? AND removed_at IS NULL",
                (username, user_id),
            )
            connection.commit()
        except sqlite3.IntegrityError:
            return jsonify({"error": "That username is already in use."}), 409
        if cursor.rowcount == 0:
            return jsonify({"error": "Account not found."}), 404
        return jsonify({"username": username}), 200

    @app.post("/api/admin/users/<int:user_id>/username")
    def admin_rename_user(user_id: int) -> tuple[Any, int]:
        require_admin()
        return rename_user(user_id, str(request_json().get("username", "")).strip())

    def verify_current_password(user: sqlite3.Row, password: str) -> bool:
        row = database().execute(
            "SELECT password_hash FROM users WHERE id = ?", (user["id"],)
        ).fetchone()
        return check_password_hash(row["password_hash"], password)

    @app.post("/api/account/username")
    def change_own_username() -> tuple[Any, int]:
        user = require_user()
        data = request_json()
        if not verify_current_password(user, str(data.get("current_password", ""))):
            return jsonify({"error": "Your current password is incorrect."}), 403
        return rename_user(user["id"], str(data.get("username", "")).strip())

    @app.post("/api/account/password")
    def change_own_password() -> tuple[Any, int]:
        user = require_user()
        data = request_json()
        if not verify_current_password(user, str(data.get("current_password", ""))):
            return jsonify({"error": "Your current password is incorrect."}), 403
        password = str(data.get("new_password", ""))
        if error := credential_error(None, password):
            return jsonify({"error": error}), 400
        connection = database()
        connection.execute(
            """
            UPDATE users SET password_hash = ?, session_version = session_version + 1
            WHERE id = ?
            """,
            (generate_password_hash(password), user["id"]),
        )
        connection.commit()
        # Other devices are signed out; this one stays signed in.
        session["session_version"] = user["session_version"] + 1
        return jsonify({"status": "password_changed"}), 200

    @app.delete("/api/admin/users/<int:user_id>")
    def admin_remove_user(user_id: int) -> tuple[Any, int]:
        admin = require_admin()
        if user_id == admin["id"]:
            return jsonify({"error": "You cannot remove your own account."}), 400
        connection = database()
        cursor = connection.execute(
            """
            UPDATE users SET removed_at = ?, session_version = session_version + 1
            WHERE id = ? AND removed_at IS NULL
            """,
            (iso_timestamp(utc_now()), user_id),
        )
        connection.commit()
        if cursor.rowcount == 0:
            return jsonify({"error": "Account not found."}), 404
        return jsonify({"status": "removed"}), 200

    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    def frontend(path: str) -> Any:
        """Serve the built React app so one port covers the whole site."""
        dist: Path = app.config["FRONTEND_DIST"]
        if path.startswith("api/") or not (dist / "index.html").is_file():
            abort(404)
        if path and (dist / path).is_file():
            max_age = 31536000 if path.startswith("assets/") else 0
            return send_from_directory(dist, path, max_age=max_age)
        return send_from_directory(dist, "index.html", max_age=0)

    @app.cli.command("create-user")
    def create_user_command() -> None:
        import getpass

        username = input("Username: ").strip()
        password = getpass.getpass("Password (at least 12 characters): ")
        if error := credential_error(username, password):
            raise SystemExit(error)
        connection = database()
        try:
            connection.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, generate_password_hash(password), iso_timestamp(utc_now())),
            )
            connection.commit()
        except sqlite3.IntegrityError as error:
            raise SystemExit("That username is already in use.") from error
        print(f"Created account for {username}.")

    @app.cli.command("reset-password")
    def reset_password_command() -> None:
        """Recovery path, including for the admin account."""
        import getpass

        username = input("Username: ").strip()
        password = getpass.getpass("New password (at least 12 characters): ")
        if error := credential_error(None, password):
            raise SystemExit(error)
        connection = database()
        cursor = connection.execute(
            """
            UPDATE users SET password_hash = ?, session_version = session_version + 1
            WHERE username = ? AND removed_at IS NULL
            """,
            (generate_password_hash(password), username),
        )
        connection.commit()
        if cursor.rowcount == 0:
            raise SystemExit("No active account has that username.")
        print(f"Password reset for {username}.")

    @app.cli.command("rename-user")
    def rename_user_command() -> None:
        """Recovery path for a forgotten username, including the admin account."""
        names = database().execute(
            "SELECT username FROM users WHERE removed_at IS NULL ORDER BY username COLLATE NOCASE"
        ).fetchall()
        print("Accounts: " + ", ".join(row["username"] for row in names))
        old_username = input("Current username: ").strip()
        new_username = input("New username: ").strip()
        if error := credential_error(new_username, None):
            raise SystemExit(error)
        connection = database()
        try:
            cursor = connection.execute(
                "UPDATE users SET username = ? WHERE username = ? AND removed_at IS NULL",
                (new_username, old_username),
            )
            connection.commit()
        except sqlite3.IntegrityError as error:
            raise SystemExit("That username is already in use.") from error
        if cursor.rowcount == 0:
            raise SystemExit("No active account has that username.")
        print(f"Renamed {old_username} to {new_username}.")

    @app.cli.command("purge-expired")
    def purge_expired_command() -> None:
        cutoff = iso_timestamp(utc_now() - TRASH_RETENTION)
        connection = database()
        expired = connection.execute(
            "SELECT * FROM photos WHERE deleted_at < ?", (cutoff,)
        ).fetchall()
        for row in expired:
            erase_photo(connection, row)
        connection.commit()
        print(f"Permanently deleted {len(expired)} expired item(s).")

    return app
