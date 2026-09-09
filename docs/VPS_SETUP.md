# VPS setup

**Status:** run for real. `ops/bootstrap-vps.sh` was executed against a fresh
Ubuntu 24.04 Hetzner box on 2026-09-09 and worked on the first attempt, with a
full round trip verified afterwards: phone upload over the public internet,
desktop collect, transcribe, commit.

Use `--dry-run` first anyway. It changes nothing and shows exactly what it will
do.

Managed by systemd rather than PM2: a self-hoster then needs no global npm
install, and systemd can sandbox the process (see the unit in
`ops/bootstrap-vps.sh`).

The design is derived from the owner's existing production setup in
`saas-backend` (`ops/bootstrap-vps.sh`, `docs/structural/deployment.md`), reduced
to what a single-user queue actually needs.

---

## What the VPS is for

It holds encrypted blobs until your PC collects them. That is all. It never
decrypts anything, never runs a model, and never touches your vault. See
`docs/PREPARATION.md` section 8.

Because of that, it is small: the cheapest tier at any provider is enough.
A 2 vCPU / 4 GB box with 40 GB of disk is generous. Disk is the only resource
that matters, and the 2 GB per-device quota bounds it.

## What you need

- A VPS running Ubuntu 24.04 LTS
- A domain or subdomain pointing at it (needed for TLS)
- An SSH keypair on your local machine
- Roughly 20 minutes

Nothing in this document is Hetzner specific. Any provider works.

---

## 1. Create the box and an admin user

Never SSH as root after this step.

Note the two different accounts, which must not be the same one:

| account | purpose | shell |
|---|---|---|
| `deploy` | the human you SSH in as | yes |
| `inkpipe` | owns the running service, created by the bootstrap script | **no login** |

```bash
ssh root@YOUR_SERVER_IP

adduser --disabled-password --gecos '' deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
usermod -aG sudo deploy
```

Confirm you can log in as `deploy` **in a second terminal** before closing the
root session. Locking yourself out here is the classic mistake.

## 2. Harden SSH

Edit `/etc/ssh/sshd_config`:

```
Port 2222
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

Then:

```bash
systemctl restart ssh
```

Again, verify in a second terminal before closing the first.

## 3. Firewall

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 2222/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

The service port is never exposed. nginx is the only thing that talks to it, over
loopback.

## 4. Node

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v    # must be 24 or newer
```

Ubuntu 24.04 ships Node 22, which is **not** enough: `node:sqlite` and native
TypeScript both need 24. The bootstrap script checks and refuses to continue on
anything older, so this step is not optional.

Node 24 is a hard requirement, not a preference: the server uses `node:sqlite`
and runs TypeScript directly, so there is no build step and no native toolchain.
The bootstrap script checks the version and refuses to continue on anything
older.

There is no PM2 here. systemd runs the service, so a self-hoster needs no global
npm install and the process can be sandboxed.

## 5. nginx and TLS

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d inkpipe.YOUR_DOMAIN
```

certbot writes the TLS configuration and sets up automatic renewal. Then replace
the server block body with a reverse proxy to the service:

```nginx
location / {
    proxy_pass http://127.0.0.1:3040;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # Blobs are capped by the server too, this is defence in depth.
    client_max_body_size 12m;
}
```

Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 6. Install inkpipe

```bash
sudo git clone https://github.com/mk4x/inkpipe.git /var/www/inkpipe
cd /var/www/inkpipe
sudo npm ci --omit=dev
```

Run exactly that. Do **not** add `--workspaces=false` thinking it will skip the
phone and desktop apps: it also skips linking `@inkpipe/protocol` and friends,
and the server then fails to start with `ERR_MODULE_NOT_FOUND`.

It pulls about 476 MB, because the workspace root installs every workspace's
dependencies and the phone app brings Expo with it. That is wasteful on a server
that needs none of it, and worth fixing later, but it is not harmful.

There is no build step. The server runs TypeScript directly on Node 24, and uses
`node:sqlite`, so there is no native toolchain to install. The checkout is owned
by root and the data directory by the service user, so a compromised process
cannot rewrite its own code.

`/var/lib/inkpipe` holds the SQLite database and the blob store. Keep it off the
repo checkout so a redeploy never touches your data.

## 7. Bootstrap

Look before you leap:

```bash
sudo bash /var/www/inkpipe/ops/bootstrap-vps.sh --dry-run
```

Then run it for real:

```bash
sudo bash /var/www/inkpipe/ops/bootstrap-vps.sh
```

Idempotent: it checks current state and changes only what is wrong. It creates
the service user and data directory, generates a join token once (re-running
never regenerates it, which would orphan an already-registered desktop), writes
a sandboxed systemd unit, starts the service, and verifies `/health` answers
before declaring success.

It deliberately does **not** install nginx or issue certificates. It should not
silently take over a web server that may already be serving other sites.

## 8. The join token

The bootstrap script prints it at the end, and stores it in `/etc/inkpipe.env`
(mode 600, root only). To read it again:

```bash
sudo grep INKPIPE_JOIN_TOKEN /etc/inkpipe.env
```

Paste it into the desktop setup wizard along with `https://inkpipe.YOUR_DOMAIN`.
It authenticates a desktop registering itself, and is not short lived: it stays
valid so you can re-register after reinstalling. Treat it like a password.

## 9. Verify

```bash
curl https://inkpipe.YOUR_DOMAIN/health
```

Expected:

```json
{ "ok": true, "version": "0.1.0", "devices": 0, "pendingBlobs": 0 }
```

The health endpoint deliberately exposes no personal data and requires no auth.

---

## Operating notes

**Backups.** Only `/var/lib/inkpipe` matters, and only slightly: blobs are
transient (deleted on ack, 30 day TTL) and your phone keeps its own copy for
90 days. Losing the box costs you pending notes, not your vault.

**Disk.** The 2 GB per-device quota and the 30 day TTL bound growth. If disk
fills anyway, something is wrong: check for a device that is uploading but never
collecting.

**Updates.** `sudo bash /var/www/inkpipe/ops/deploy.sh`. It fast-forwards to
origin/main, reinstalls dependencies, restarts, and checks `/health`. If the new
revision does not come up healthy it **rolls back automatically** to the previous
commit and tells you. It refuses to deploy over local uncommitted edits.

**Logs.** `journalctl -u inkpipe -f`.

**Restart.** `sudo systemctl restart inkpipe`.

## If you already run other services on this box

The owner's box already has nginx, Node and a `deploy` user from `saas-backend`.
In that case skip steps 1 to 4, add only the new nginx server block in step 5,
and pick a service port that is not already taken. Ports 3010, 3011, 3020, 3021
and 3030 are in use there, which is why inkpipe defaults to **3040**.

inkpipe uses its own systemd unit and its own `inkpipe` service user, so it does
not touch the existing PM2 setup or the `deploy` user.

## Threat model reminder

An attacker who fully owns this box gets: a list of device public keys, blob
sizes and timestamps, and ciphertext they cannot read. They do not get your
notes, your vault, or your GitHub credentials, because none of those are ever
here. If you find yourself adding a feature that changes that sentence, stop and
re-read `docs/PREPARATION.md` section 8.

## Self-hosted search for expansion (ADR 0004)

Expansion checks its explanations against web search snippets. The provider is
SearXNG running on this server: it queries Google underneath, so the index is
the same, and it needs no API key, no account, no quota and no billing.

That last part is the reason it is here rather than using Google's own API.
Four Google API keys across two Cloud projects were refused with a project level
error while the console showed the API enabled and the project's own metrics
showed the requests arriving. A backend that depends on an account staying in
good standing is a backend that breaks again later.

Docker is required. It is not enabled by default on a fresh Hetzner image, and
if you disabled it during cleanup you must enable it again or search stops
working after the next reboot.

```bash
systemctl enable --now docker
```

Write the settings. Two lines matter and neither is the default: `json` in
`search.formats`, without which the instance answers with an HTML page, and
`limiter: false`, because the limiter blocks anything that does not look like a
browser and our client is not one.

```bash
mkdir -p /etc/searxng
openssl rand -hex 24 > /etc/searxng/inkpipe-token
chmod 600 /etc/searxng/inkpipe-token
```

Then `/etc/searxng/settings.yml`:

```yaml
use_default_settings: true
general:
  instance_name: "inkpipe search"
  enable_metrics: false
server:
  secret_key: "GENERATE WITH openssl rand -hex 32"
  limiter: false
  public_instance: false
  image_proxy: false
search:
  formats:
    - html
    - json
  safe_search: 0
outgoing:
  request_timeout: 6.0
```

Run it, bound to loopback so nothing reaches it except through nginx:

```bash
docker run -d --name searxng --restart unless-stopped \
  -p 127.0.0.1:8888:8080 \
  -v /etc/searxng:/etc/searxng \
  -e SEARXNG_BASE_URL=https://YOUR_HOST/searx/ \
  --memory 512m \
  docker.io/searxng/searxng:latest
```

Add a location to the existing vhost, **above** the catch-all `location /`.
The token check is not optional. Without it this is an open search proxy for
anyone who finds the hostname, and it will be found.

```nginx
location /searx/ {
    if ($http_x_inkpipe_token != "THE TOKEN FROM /etc/searxng/inkpipe-token") { return 403; }
    proxy_pass http://127.0.0.1:8888/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 20s;
}
```

Never write the nginx backup inside `sites-enabled`. Everything in that
directory is loaded, so a copy of the vhost is a duplicate server block and
nginx refuses to start. Keep backups in `/root/nginx-backups`.

Verify from your desktop, not from the server, since the point is the token:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://YOUR_HOST/searx/search?q=test&format=json"
```

That must print `403`. With `-H "x-inkpipe-token: THE_TOKEN"` it must print
`200`. Put the token in `secrets.json` on the desktop as `searxngToken`, and the
URL in `config.json` as `research.host`.
