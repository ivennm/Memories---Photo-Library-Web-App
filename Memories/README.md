# Memories — family photo library

A private, self-hosted photo and video library for family members on your Tailscale network. It includes per-person sign-in, uploads, a library sorted by date taken, uploader attribution, exact-file duplicate detection, a restorable 30-day trash, and an admin account for managing family members.

## Stack and storage

- React + TypeScript + Vite frontend, built to static files.
- Python Flask JSON API, served in production by Gunicorn. Gunicorn also serves the built frontend, so the whole site is on one local port.
- SQLite for accounts and media metadata.
- Original media in `MEDIA_ROOT`, on the dedicated 1 TB media drive (`/mnt/drive-2`), separate from the OS disk and the app code.

**Dates.** Photo dates come from EXIF, including the timezone offset iPhones record; photos without an offset are assumed to be in the server's timezone. Video dates come from the file's metadata (iPhones record the local time and offset). Upload time is used when there is no date. All timestamps are stored in UTC. Files are placed under `MEDIA_ROOT/YYYY/MM/` by the local date the photo was taken.

**Thumbnails and video streaming copies.** A background worker (`memories-worker.service`, running `flask process-media --watch`) makes an 800 px JPEG thumbnail for every photo and a poster frame for every video under `MEDIA_ROOT/_thumbs/`, and a 1080p H.264 streaming copy (about 3–6 Mbps, AAC audio, fast-start) of each video under `MEDIA_ROOT/_streams/`, so video plays smoothly away from home. iPhone HDR video is tone-mapped to SDR. H.264 videos at 8 Mbps or less with AAC/MP3 audio are played directly. Video capture dates are read from the file's metadata at upload (older videos are re-dated and moved to the right `YYYY/MM` folder by the worker). Items show "Processing…" until done; a file that can't be processed is marked failed and keeps playing from the original. All of these are rebuildable from the originals; Save to Photos and downloads always return the original. Requires `ffmpeg`.

**iPhone photos.** HEIC/HEIF (and TIFF) photos are stored untouched, and a JPEG display copy is saved under `MEDIA_ROOT/_previews/` so they show in every browser. Downloads always return the original file. Display copies can be regenerated from originals, but are included when you copy `MEDIA_ROOT`.

**Albums.** The Albums tab is shared by the whole family. **Favorites** is made automatically and starts empty; there is one **Uploaded by <name>** album per person, filled automatically from who uploaded each item. Neither kind can be renamed or deleted. Anyone can create, rename and delete their own albums and add items with the "…" menu (Add to Favorites, Add to album). Albums only point at items, so nothing is copied, an item can be in several albums, and deleting an album never deletes photos. Items in Recently deleted are hidden from albums and return if restored. **Upload photos** on an album page uploads straight into that album, which is how to bring over an album from iPhone Photos (in the picker: Albums, open the album, drag across the photos to select them all). Files already in Memories are added to the album instead of being refused, and ones in Recently deleted are restored, so no copies are made and re-running an interrupted upload is safe. Each album you create has a **Show in All photos** setting (on by default). Turned off, the album's items appear only in their albums (including Favorites), not in All photos or the Uploaded by albums; if an item is in several albums, any album with the setting off keeps it out. It's for tidiness, not privacy: everyone can still open the album.

**Viewer.** Tapping a photo or video opens it full screen. Swipe sideways (on a computer: the arrow buttons or the ← → keys) to move through the items in the order the page shows them, swipe down, press Esc or use the phone's Back gesture to close, and tap a photo to hide the bars. The tapped video starts playing; others play with the play button and pause when you swipe away. Photos show the thumbnail first, then the full-size display copy (originals are only sent by Save to Photos / Download, still in the ··· menu in the viewer).

**Duplicates.** Detection uses SHA-256, so it catches byte-identical files, not resized or recompressed copies. Re-uploading a file that is in Recently deleted shows a notice with a Restore button.

## Accounts

- The first account, created in the browser on first launch, is the **admin**. It is the only admin.
- Signing in lasts 30 days on that device, and every visit restarts the 30 days, so people who use the app regularly stay signed in. Sign out, a password change or reset, or removing the account ends it sooner.
- Everyone has a **My account** page to change their own username or password (current password required; changing the password signs out their other devices).
- The admin's **Family accounts** page adds accounts, renames them, resets passwords, and removes accounts.
- The admin can also create an **invite link** (`/join/<code>`) so a family member sets up their own account. Each link creates one account only, expires after 7 days, and can be revoked while unused. Only a hash of the link's code is stored. The person still needs to be on the tailnet to open it. Resetting a password or removing an account signs that person out on every device. Removed accounts cannot sign in, but their photos stay in the library, still credited to them.
- Everyone can upload and move items to the trash; anyone can restore. Only the admin can **Delete forever** from the trash before the 30 days are up.
- Server-side recovery commands, including for a forgotten admin username or password:

```sh
flask --app backend.app:create_app create-user
flask --app backend.app:create_app reset-password
flask --app backend.app:create_app rename-user
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

Run Gunicorn under `systemd` (not Flask's development server). Gunicorn listens on `127.0.0.1:8000` and Tailscale Serve publishes it over HTTPS at `https://mc-server.tailc7ae2e.ts.net` (step 3). HTTPS is needed for saving originals straight to Photos on iPhone and for the invite Share button. Plain HTTP on the Tailscale address also works (see the comment in `/etc/memories.env`).

1. Build the frontend as your normal user, then run the install script from the project folder:

   ```sh
   (cd frontend && npm run build)
   sudo deploy/install.sh
   ```

   [deploy/install.sh](./deploy/install.sh) creates the `memories` service account, `/var/lib/memories` and `/mnt/drive-2/memories`, copies the app to `/opt/memories` with its own virtualenv, copies `data/photolibrary.sqlite3` to `/var/lib/memories` on first install, writes `/etc/memories.env` with a random `SECRET_KEY` if it doesn't exist (readable only by root and `memories`), installs and enables `memories.service`, `memories-worker.service` and `memories-purge.timer`, and checks that the app answers. It needs Tailscale connected (it reads the address from `tailscale ip -4`). It refuses to run if the media drive isn't mounted.

   `/etc/memories.env` contains:

   ```ini
   APP_ENV=production
   SECRET_KEY=<random>
   DATABASE_PATH=/var/lib/memories/photolibrary.sqlite3
   MEDIA_MOUNT=/mnt/drive-2
   MEDIA_ROOT=/mnt/drive-2/memories/library
   MAX_UPLOAD_MB=2048
   MEMORIES_BIND=127.0.0.1:8000
   SESSION_COOKIE_SECURE=true
   ```

2. The service starts at boot (after Tailscale, retrying until its address is ready), restarts if it crashes, and keeps running when you log out. The purge timer runs hourly and permanently removes items that have been in the trash for 30 days. Useful commands:

   ```sh
   systemctl status memories
   journalctl -u memories -f          # live log
   sudo systemctl restart memories
   ```

3. Publish it over HTTPS: enable MagicDNS and HTTPS certificates in the Tailscale admin console (DNS page), then:

   ```sh
   sudo tailscale serve --bg 8000
   tailscale serve status
   ```

   The library is then at `https://<server-name>.<tailnet>.ts.net` for devices on your tailnet. Do not use `tailscale funnel`, which would expose it to the public internet.

To update the app later, run `./update.sh` from the project folder as your normal user (not with sudo). It runs the tests, rebuilds the frontend, runs `sudo deploy/install.sh` and checks the site answers; `--skip-tests` skips the tests. Doing it by hand: rebuild the frontend and run `sudo deploy/install.sh` again. It replaces the code, updates packages and restarts the service; it never overwrites the database, media or `/etc/memories.env`.

For development test runs alongside the service, use a separate `DATABASE_PATH` and `MEDIA_ROOT` under `data/` (the media folder on the drive belongs to the `memories` account after install).

Back up both the SQLite database and `MEDIA_ROOT`. The database holds the accounts, metadata and relative file paths; the media files are the irreplaceable originals.

## Media drive

Originals live on the dedicated 1 TB HDD (`/dev/sda1`, ext4, label `drive-2`), not on the OS disk. It is mounted at `/mnt/drive-2` by UUID in `/etc/fstab` with `nofail`, so the server still boots if the drive is missing. Device names (`sda`/`sdb`) can swap between boots; always refer to the drive by UUID or label.

Because a missing drive leaves an empty `/mnt/drive-2` folder on the OS disk, two guards keep media off the OS disk:

- `MEDIA_MOUNT=/mnt/drive-2` makes the app refuse to start unless that path is a mounted drive and `MEDIA_ROOT` is inside it, and refuses uploads and permanent deletes (HTTP 503) if the drive disappears while running.
- The systemd units have `RequiresMountsFor=/mnt/drive-2`, so they do not start until the drive is mounted.

`DATABASE_PATH` stays on the server's internal storage (`/var/lib/memories`); back it up separately.

To move the library to another drive later: stop the app, copy the contents of `MEDIA_ROOT` to the new location, verify the copy (the database stores each original's SHA-256), update `MEDIA_MOUNT`, `MEDIA_ROOT`, `RequiresMountsFor` and `ReadWritePaths`, then start the app and confirm the library before removing the old copy. Do not change `MEDIA_ROOT` alone while files remain at the old location.

## Current boundaries

Not yet included: video capture dates, video conversion for browsers that cannot play iPhone HEVC video, search and filters, login rate limiting, and a guided storage-migration tool.
