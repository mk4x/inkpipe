#!/usr/bin/env bash
# bootstrap-vps.sh - bring a fresh Ubuntu VPS to a running inkpipe server.
#
# Idempotent: re-running is safe. Every step checks current state and changes
# only what is wrong, then validates the result and fails loudly rather than
# half-succeeding.
#
# Modelled on the pattern from the owner's saas-backend, reduced to what a
# single-user encrypted queue actually needs.
#
# Usage:
#   sudo bash ops/bootstrap-vps.sh [--port 3040] [--user inkpipe] [--dry-run]
#
# What it does NOT do, deliberately:
#   - install nginx or issue certificates. TLS is yours to configure, and the
#     script should not silently take over a web server that may already be
#     serving other sites.
#   - open firewall ports. See docs/VPS_SETUP.md.

set -euo pipefail

PORT=3040
SERVICE_USER=inkpipe
APP_DIR=/var/www/inkpipe
DATA_DIR=/var/lib/inkpipe
UNIT=/etc/systemd/system/inkpipe.service
ENV_FILE=/etc/inkpipe.env
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m->\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32mok\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then printf '   would run: %s\n' "$*"; else "$@"; fi; }

# --- 1. preconditions -------------------------------------------------------

if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  err "must run as root: sudo bash ops/bootstrap-vps.sh"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  err "node is not installed. inkpipe needs Node 24 or newer."
  err "  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -"
  err "  sudo apt-get install -y nodejs"
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 24 ]; then
  err "node $NODE_MAJOR found, but inkpipe needs 24 or newer."
  err "It relies on node:sqlite and native TypeScript, so this is not optional."
  exit 1
fi
ok "node $(node -v)"

for cmd in git openssl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd is not installed: sudo apt-get install -y $cmd"
    exit 1
  fi
done
ok "git and openssl present"

# --- 2. service user --------------------------------------------------------

if id "$SERVICE_USER" >/dev/null 2>&1; then
  ok "user $SERVICE_USER exists"
else
  log "creating system user $SERVICE_USER"
  # No login shell and no home: this account exists only to own the process.
  run useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "created $SERVICE_USER"
fi

# --- 3. directories ---------------------------------------------------------

for dir in "$APP_DIR" "$DATA_DIR"; do
  if [ -d "$dir" ]; then
    ok "$dir exists"
  else
    log "creating $dir"
    run mkdir -p "$dir"
  fi
done

# Data is owned by the service user; the checkout is not, so a compromised
# process cannot rewrite its own code.
run chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
run chmod 700 "$DATA_DIR"
ok "$DATA_DIR owned by $SERVICE_USER, mode 700"

# --- 4. join token ----------------------------------------------------------
#
# Generated once and kept. Regenerating it on every run would invalidate a
# desktop that is already registered.

if [ -f "$ENV_FILE" ] && grep -q '^INKPIPE_JOIN_TOKEN=' "$ENV_FILE" 2>/dev/null; then
  ok "join token already set in $ENV_FILE"
  EXISTING_TOKEN=$(grep '^INKPIPE_JOIN_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
else
  log "generating a join token"
  EXISTING_TOKEN=$(openssl rand -base64 24 | tr -d '\n/+=' | cut -c1-32)
  if [ "$DRY_RUN" -eq 0 ]; then
    cat > "$ENV_FILE" <<EOF
# Managed by ops/bootstrap-vps.sh. Re-run it rather than editing by hand.
INKPIPE_PORT=$PORT
INKPIPE_HOST=127.0.0.1
INKPIPE_DATA_DIR=$DATA_DIR
INKPIPE_JOIN_TOKEN=$EXISTING_TOKEN
EOF
    chmod 600 "$ENV_FILE"
    chown root:root "$ENV_FILE"
  else
    printf '   would write %s\n' "$ENV_FILE"
  fi
  ok "join token written to $ENV_FILE (mode 600)"
fi

# --- 5. systemd unit --------------------------------------------------------

read -r -d '' UNIT_CONTENT <<EOF || true
[Unit]
Description=inkpipe encrypted note queue
Documentation=https://github.com/mk4x/inkpipe
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/apps/server/src/index.ts
Restart=on-failure
RestartSec=5

# The server stores opaque ciphertext and never executes anything it receives,
# so it can be locked down hard.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF

if [ "$DRY_RUN" -eq 1 ]; then
  printf '   would write %s\n' "$UNIT"
elif [ -f "$UNIT" ] && [ "$(cat "$UNIT")" = "$UNIT_CONTENT" ]; then
  ok "systemd unit unchanged"
else
  log "writing $UNIT"
  printf '%s\n' "$UNIT_CONTENT" > "$UNIT"
  systemctl daemon-reload
  ok "systemd unit written"
fi

run systemctl enable inkpipe >/dev/null 2>&1 || true

# --- 6. validate ------------------------------------------------------------

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  ok "dry run complete, nothing was changed"
  exit 0
fi

if [ ! -f "$APP_DIR/apps/server/src/index.ts" ]; then
  err "no checkout at $APP_DIR yet. Clone it, then re-run this script:"
  err "  git clone https://github.com/mk4x/inkpipe.git $APP_DIR"
  err "  cd $APP_DIR && npm ci --omit=dev"
  exit 1
fi

log "restarting inkpipe"
systemctl restart inkpipe
sleep 2

if ! systemctl is-active --quiet inkpipe; then
  err "service failed to start. Recent logs:"
  journalctl -u inkpipe -n 30 --no-pager >&2
  exit 1
fi

if ! curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null; then
  err "service is running but /health did not answer on port $PORT"
  journalctl -u inkpipe -n 30 --no-pager >&2
  exit 1
fi

echo
ok "inkpipe is running on 127.0.0.1:$PORT"
echo
echo "Join token, paste this into the desktop setup wizard:"
echo
echo "    $EXISTING_TOKEN"
echo
echo "Next: put nginx in front with TLS. See docs/VPS_SETUP.md section 5."
