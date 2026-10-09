# Gather — family photo library

A private, self-hosted photo and video library for family members on your Tailscale network. The current first slice includes account sign-in, upload, a date-sorted library, uploader attribution, exact-file duplicate detection, and a restorable 30-day trash.

## Stack and storage

- React + TypeScript + Vite frontend.
- Python Flask JSON API, served in production by Gunicorn.
- SQLite for accounts and media metadata.
- Original media in `MEDIA_ROOT`, separate from the app code and configurable for the future external drive.

Photo dates are read from EXIF when available; upload time is used otherwise. Video capture dates currently fall back to upload time. Files are placed under `MEDIA_ROOT/YYYY/MM/` based on the selected date. Duplicate detection uses SHA-256, so it detects byte-identical files, not resized/recompressed copies.

## Run locally for development

Requirements: Python 3.11+ (including its `venv` module) and Node.js 20+.

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

cd frontend
npm ci
npm run dev
```

In a second terminal, from the project root, start the API:

```sh
. .venv/bin/activate
export SECRET_KEY='local-development-only'
export DATABASE_PATH="$PWD/data/photolibrary.sqlite3"
export MEDIA_ROOT="$PWD/data/library"
flask --app backend.app:create_app run --host 127.0.0.1 --port 8000
```

Open the address printed by Vite (normally `http://localhost:5173`). The first account can be created from the sign-in page; that one-time setup route closes after the first account is created. Use a unique password of at least 12 characters. Add each additional family account on the server with:

```sh
flask --app backend.app:create_app create-user
```

## Keep it running on a server

For continuous use, run Gunicorn under `systemd`; do not use Flask's development server. Put Caddy or another HTTPS reverse proxy in front, and expose the site only on your Tailscale network. Keep the API bound to localhost.

Create a dedicated service account and writable data directories. Keep the source checkout and virtual environment under `/opt/family-photos`; the service only needs write access to its database and media directories:

```sh
sudo useradd --system --home-dir /opt/family-photos --shell /usr/sbin/nologin family-photos
sudo install -d -o family-photos -g family-photos /var/lib/family-photos /srv/family-photos
```

Production environment values (for example in `/etc/family-photos.env`):

```ini
APP_ENV=production
SECRET_KEY=replace-with-a-long-random-secret
DATABASE_PATH=/var/lib/family-photos/photolibrary.sqlite3
MEDIA_ROOT=/srv/family-photos/library
MAX_UPLOAD_MB=2048
SESSION_COOKIE_SECURE=true
```

Generate the secret with `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'`. Create the directories and grant the service account read/write access to both. For local development over plain HTTP, leave `SESSION_COOKIE_SECURE` unset; production should use HTTPS.

Install [family-photos.service](./deploy/family-photos.service) under `/etc/systemd/system/`, then run `sudo systemctl daemon-reload && sudo systemctl enable --now family-photos.service`. The included unit runs Gunicorn as the unprivileged `family-photos` account. Adjust its paths and `ReadWritePaths` if you choose different locations.

Build the frontend with `cd frontend && npm ci && npm run build`. Configure the reverse proxy to serve `frontend/dist` and proxy `/api/*` to `127.0.0.1:8000`. Do not expose the development server or the Gunicorn port directly to the internet.

The included [purge service](./deploy/family-photos-purge.service) and [hourly timer](./deploy/family-photos-purge.timer) enforce the 30-day trash period. Install both under `/etc/systemd/system/`, then run `sudo systemctl daemon-reload && sudo systemctl enable --now family-photos-purge.timer`. Monitor the service logs so storage or permission errors are visible.

Back up both the SQLite database and original-media directory. The database contains the metadata and relative file paths needed to reconnect the library; the media files are the irreplaceable originals.

## Moving to the external drive

When the drive is installed and mounted, stop the app, copy the contents of `MEDIA_ROOT` to the new library directory, verify the copy (the database stores each file's SHA-256), update `MEDIA_ROOT`, then start the app and confirm the library before removing the old copy. Keep `DATABASE_PATH` on the server's internal storage and back it up separately. Do not change `MEDIA_ROOT` alone while files remain at the old location.

## Current boundaries

This is the first working slice, not yet a full Google Drive replacement. The initial account can be created in the browser; subsequent users are created by a server operator. Video capture-date extraction, thumbnails, albums, advanced search, and a guided storage-migration tool are not included yet. The external drive should be mounted persistently by the operating system before configuring `MEDIA_ROOT` to it.
