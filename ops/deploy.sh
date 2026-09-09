#!/usr/bin/env bash
# deploy.sh - update a running inkpipe server to the current main.
#
# Safe to re-run. Refuses rather than guessing whenever the state is not what it
# expects, because a half-deployed queue silently drops pages.
#
# Usage (on the VPS):
#   sudo bash /var/www/inkpipe/ops/deploy.sh [--ref main] [--no-restart]

set -euo pipefail

APP_DIR=${INKPIPE_APP_DIR:-/var/www/inkpipe}
REF=main
RESTART=1

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --no-restart) RESTART=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;36m->\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32mok\033[0m %s\n' "$*"; }
err() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  err "must run as root: sudo bash $0"
  exit 1
fi

cd "$APP_DIR" || { err "no checkout at $APP_DIR"; exit 1; }

# --- refuse to deploy over local edits --------------------------------------
#
# The same rule the vault writer follows: never mix someone's uncommitted work
# into an automated operation.
if [ -n "$(git status --porcelain)" ]; then
  err "$APP_DIR has uncommitted changes. Refusing to deploy over them."
  git status --short >&2
  exit 1
fi

PREVIOUS=$(git rev-parse HEAD)
log "current: $PREVIOUS"

log "fetching"
git fetch --quiet origin "$REF"

# Fast-forward only. A merge here would mean the server is running code that
# exists nowhere else, which makes a rollback undefined.
if ! git merge --ff-only "origin/$REF" >/dev/null 2>&1; then
  err "cannot fast-forward to origin/$REF. The checkout has diverged."
  err "Resolve it by hand: the server must run code that exists upstream."
  exit 1
fi

TARGET=$(git rev-parse HEAD)
if [ "$PREVIOUS" = "$TARGET" ]; then
  ok "already at $TARGET, nothing to do"
  exit 0
fi
ok "updated to $TARGET"

log "installing dependencies"
npm ci --omit=dev --silent

if [ "$RESTART" -eq 0 ]; then
  ok "skipping restart as asked"
  exit 0
fi

log "restarting"
systemctl restart inkpipe
sleep 2

PORT=$(grep '^INKPIPE_PORT=' /etc/inkpipe.env 2>/dev/null | cut -d= -f2 || echo 3040)

# --- verify, and roll back if the new code does not answer ------------------
if systemctl is-active --quiet inkpipe && curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null; then
  ok "healthy on port $PORT, now at $TARGET"
  exit 0
fi

err "the new revision did not come up healthy. Rolling back to $PREVIOUS."
git reset --hard "$PREVIOUS" >/dev/null
npm ci --omit=dev --silent
systemctl restart inkpipe
sleep 2

if systemctl is-active --quiet inkpipe && curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null; then
  err "rolled back successfully. The server is running $PREVIOUS again."
  err "Investigate before retrying. Recent logs:"
  journalctl -u inkpipe -n 30 --no-pager >&2
  exit 1
fi

err "ROLLBACK ALSO FAILED. The server is down and needs manual attention."
journalctl -u inkpipe -n 50 --no-pager >&2
exit 2
