# VPS setup

**Status:** the scripts exist and the server runs. `ops/bootstrap-vps.sh` has
been syntax checked and dry-run, but has **not yet been executed against a real
VPS**, so treat the first run as the real test and use `--dry-run` first.

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
