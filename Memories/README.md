# Memories — family photo library

A private, self-hosted photo and video library for family members on your Tailscale network. It includes per-person sign-in, uploads, a library sorted by date taken, uploader attribution, exact-file duplicate detection, a restorable 30-day trash, and an admin account for managing family members.

## Stack and storage

- React + TypeScript + Vite frontend, built to static files.
- Python Flask JSON API, served in production by Gunicorn. Gunicorn also serves the built frontend, so the whole site is on one local port.
- SQLite for accounts and media metadata.
- Original media in `MEDIA_ROOT`, separate from the app code and configurable for the future external drive.

**Dates.** Photo dates come from EXIF, including the timezone offset iPhones record; photos without an offset are assumed to be in the server's timezone. Upload time is used when there is no EXIF date (currently always the case for videos). All timestamps are stored in UTC. Files are placed under `MEDIA_ROOT/YYYY/MM/` by the local date the photo was taken.

**iPhone photos.** HEIC/HEIF (and TIFF) photos are stored untouched, and a JPEG display copy is saved under `MEDIA_ROOT/_previews/` so they show in every browser. Downloads always return the original file. Display copies can be regenerated from originals, but are included when you copy `MEDIA_ROOT`.

**Duplicates.** Detection uses SHA-256, so it catches byte-identical files, not resized or recompressed copies. Re-uploading a file that is in Recently deleted shows a notice with a Restore button.

## Accounts

- The first account, created in the browser on first launch, is the **admin**. It is the only admin.
- The admin's **Family accounts** page adds accounts, resets passwords, and removes accounts. Resetting a password or removing an account signs that person out on every device. Removed accounts cannot sign in, but their photos stay in the library, still credited to them.
- Everyone can upload and move items to the trash; anyone can restore. Only the admin can **Delete forever** from the trash before the 30 days are up.
- Server-side recovery commands, including for a forgotten admin password:

```sh
flask --app backend.app:create_app create-user
flask --app backend.app:create_app reset-password
```

## Requirements

Python 3.11+, Node.js 20+ (only to build the frontend), and on Debian:

```sh
sudo apt install -y python3-venv ffmpeg
```

`ffmpeg` is not used yet; it is needed for upcoming video work. If Node.js is not installed system-wide, a user-local copy can be used by adding it to `PATH`, for example `export PATH="$HOME/.local/opt/node/bin:$PATH"`.

## Run locally for development

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt

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

Open the address printed by Vite (normally `http://localhost:5173`). Run the tests with `pytest`.

## Keep it running on the server

Run Gunicorn under `systemd` (not Flask's development server) and publish it on your tailnet with Tailscale Serve, which provides HTTPS. Gunicorn stays bound to localhost.

1. Create a service account and data directories, and put the app in `/opt/memories`:

   ```sh
   sudo useradd --system --home-dir /opt/memories --shell /usr/sbin/nologin memories
   sudo install -d -o memories -g memories /var/lib/memories /srv/memories
   sudo cp -r . /opt/memories   # from this project folder
   cd /opt/memories
   sudo python3 -m venv .venv && sudo .venv/bin/pip install -r requirements.txt
   cd frontend && sudo npm ci && sudo npm run build
   ```

2. Create `/etc/memories.env` (readable only by root and `memories`):

   ```ini
   APP_ENV=production
   SECRET_KEY=replace-with-a-long-random-secret
   DATABASE_PATH=/var/lib/memories/photolibrary.sqlite3
   MEDIA_ROOT=/srv/memories/library
   MAX_UPLOAD_MB=2048
   SESSION_COOKIE_SECURE=true
   ```

   Generate the secret with `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'`.

3. Install and start the units in [deploy/](./deploy/):

   ```sh
   sudo cp deploy/memories.service deploy/memories-purge.service deploy/memories-purge.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now memories.service memories-purge.timer
   ```

   The purge timer runs hourly and permanently removes items that have been in the trash for 30 days. Check logs with `journalctl -u memories -u memories-purge`.

4. Publish it on the tailnet. MagicDNS and HTTPS certificates must be enabled in the Tailscale admin console (DNS page). Then:

   ```sh
   sudo tailscale serve --bg 8000
   tailscale serve status
   ```

   The library is then at `https://<server-name>.<tailnet>.ts.net` for devices on your tailnet. Do not use `tailscale funnel`, which would expose it to the public internet.

To update the app later: copy the new code to `/opt/memories`, reinstall requirements, rebuild the frontend, and `sudo systemctl restart memories`.

Back up both the SQLite database and `MEDIA_ROOT`. The database holds the accounts, metadata and relative file paths; the media files are the irreplaceable originals.

## Moving to the external drive

When the drive is installed and mounted persistently (via `/etc/fstab`), stop the app, copy the contents of `MEDIA_ROOT` to the new library directory, verify the copy (the database stores each original's SHA-256), update `MEDIA_ROOT` and `ReadWritePaths` in the systemd units, then start the app and confirm the library before removing the old copy. Keep `DATABASE_PATH` on the server's internal storage and back it up separately. Do not change `MEDIA_ROOT` alone while files remain at the old location.

## Current boundaries

Not yet included: video capture dates, video conversion for browsers that cannot play iPhone HEVC video, thumbnails, albums, search and filters, login rate limiting, and a guided storage-migration tool.
