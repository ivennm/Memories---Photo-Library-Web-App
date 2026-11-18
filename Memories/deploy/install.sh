#!/usr/bin/env bash
# Install or update Memories as an always-on systemd service.
#
#   1. Build the frontend as your normal user:  (cd frontend && npm run build)
#   2. Run from the project folder:             sudo deploy/install.sh
#
# Safe to run again after code changes: it copies the new code, updates Python packages and
# restarts the service. Existing data, the database and /etc/memories.env are never overwritten.
set -euo pipefail

APP_DIR=/opt/memories
DATA_DIR=/var/lib/memories
MEDIA_MOUNT=/mnt/drive-2
MEDIA_DIR=$MEDIA_MOUNT/memories
ENV_FILE=/etc/memories.env
SOURCE_DIR=$(cd "$(dirname "$0")/.." && pwd)

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo deploy/install.sh" >&2
  exit 1
fi
if [[ ! -f $SOURCE_DIR/frontend/dist/index.html ]]; then
  echo "Build the frontend first (as your normal user): cd frontend && npm run build" >&2
  exit 1
fi
TAILSCALE_IP=$(tailscale ip -4 2>/dev/null | head -n1 || true)
if [[ -z $TAILSCALE_IP ]]; then
  echo "Tailscale is not connected (tailscale ip -4 returned nothing)." >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg is required for thumbnails and video copies: sudo apt install ffmpeg" >&2
  exit 1
fi
if ! mountpoint -q "$MEDIA_MOUNT"; then
  echo "The media drive is not mounted at $MEDIA_MOUNT; refusing to install." >&2
  exit 1
fi

echo "==> Service account and folders"
id memories &>/dev/null || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin memories
install -d -o memories -g memories "$DATA_DIR" "$MEDIA_DIR"
install -d "$APP_DIR" "$APP_DIR/frontend"

echo "==> Copying the app to $APP_DIR"
rm -rf "$APP_DIR/backend" "$APP_DIR/frontend/dist"
cp -r "$SOURCE_DIR/backend" "$APP_DIR/backend"
cp -r "$SOURCE_DIR/frontend/dist" "$APP_DIR/frontend/dist"
cp "$SOURCE_DIR/requirements.txt" "$APP_DIR/"
find "$APP_DIR/backend" -name __pycache__ -prune -exec rm -rf {} +

echo "==> Python packages"
[[ -x $APP_DIR/.venv/bin/python ]] || python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/.venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

# First install only: bring over the test library's database (accounts + photo records).
if [[ ! -f $DATA_DIR/photolibrary.sqlite3 && -f $SOURCE_DIR/data/photolibrary.sqlite3 ]]; then
  echo "==> Copying the existing database to $DATA_DIR"
  python3 -c 'import sqlite3, sys
src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2])
src.backup(dst); dst.close(); src.close()' \
    "$SOURCE_DIR/data/photolibrary.sqlite3" "$DATA_DIR/photolibrary.sqlite3"
fi
chown -R memories:memories "$DATA_DIR" "$MEDIA_DIR"

if [[ ! -f $ENV_FILE ]]; then
  echo "==> Writing $ENV_FILE with a new secret key"
  (umask 077; cat > "$ENV_FILE") <<EOF
APP_ENV=production
SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
DATABASE_PATH=$DATA_DIR/photolibrary.sqlite3
MEDIA_MOUNT=$MEDIA_MOUNT
MEDIA_ROOT=$MEDIA_DIR/library
MAX_UPLOAD_MB=4096
# Served over HTTPS by tailscale serve (sudo tailscale serve --bg 8000), which forwards to this port.
# For plain HTTP on the Tailscale address instead: MEMORIES_BIND=$TAILSCALE_IP:8000 and
# SESSION_COOKIE_SECURE=false.
MEMORIES_BIND=127.0.0.1:8000
SESSION_COOKIE_SECURE=true
EOF
  chown root:memories "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

# Env files written by the first version of this script had no MEMORIES_BIND; they were already
# set up for HTTPS (SESSION_COOKIE_SECURE=true), so they get the matching tailscale-serve port.
grep -q '^MEMORIES_BIND=' "$ENV_FILE" || echo "MEMORIES_BIND=127.0.0.1:8000" >> "$ENV_FILE"
BIND=$(sed -n 's/^MEMORIES_BIND=//p' "$ENV_FILE" | tail -n1)

echo "==> systemd units"
cp "$SOURCE_DIR"/deploy/memories.service "$SOURCE_DIR"/deploy/memories-worker.service \
   "$SOURCE_DIR"/deploy/memories-purge.service "$SOURCE_DIR"/deploy/memories-purge.timer \
   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet memories.service memories-worker.service memories-purge.timer
systemctl restart memories.service memories-worker.service
systemctl start memories-purge.timer

echo "==> Checking the app"
for _ in $(seq 20); do
  if curl -fsS "http://$BIND/api/health" >/dev/null 2>&1; then
    echo "Memories is running on $BIND (systemctl status memories, journalctl -u memories -f)."
    # Read the status into a variable first: with pipefail, "| grep -q" can report a false failure.
    SERVE_STATUS=$(tailscale serve status 2>/dev/null || true)
    if [[ $BIND == 127.0.0.1:* && $SERVE_STATUS != *"127.0.0.1:${BIND##*:}"* ]]; then
      echo "Not published yet: enable HTTPS certificates in the Tailscale admin console (DNS page),"
      echo "then run: sudo tailscale serve --bg ${BIND##*:}"
    fi
    exit 0
  fi
  sleep 1
done
echo "Memories did not start; see: journalctl -u memories -n 50" >&2
exit 1
