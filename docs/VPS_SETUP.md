# VPS setup

**Status:** planned procedure. `ops/bootstrap-vps.sh` and `apps/server` do not
exist yet, so steps 6 onward cannot be run today. Steps 1 to 5 are standard and
are correct now. This document is written first so that the scripts are built to
match it rather than the other way round.

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

## 1. Create the box and a non-root user

Never run the service as root, and never SSH as root after this step.

```bash
ssh root@YOUR_SERVER_IP

adduser --disabled-password --gecos '' inkpipe
mkdir -p /home/inkpipe/.ssh
cp /root/.ssh/authorized_keys /home/inkpipe/.ssh/
chown -R inkpipe:inkpipe /home/inkpipe/.ssh
chmod 700 /home/inkpipe/.ssh
chmod 600 /home/inkpipe/.ssh/authorized_keys
```

Confirm you can log in as `inkpipe` **in a second terminal** before closing the
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

## 4. Node and pm2

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pm2
pm2 startup    # then run the command it prints
```

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

## 6. Install inkpipe (not yet available)

```bash
sudo mkdir -p /var/www/inkpipe /var/lib/inkpipe
sudo chown inkpipe:inkpipe /var/www/inkpipe /var/lib/inkpipe

sudo -u inkpipe git clone https://github.com/mk4x/inkpipe.git /var/www/inkpipe
cd /var/www/inkpipe
sudo -u inkpipe npm ci
sudo -u inkpipe npm run build --workspace apps/server
```

`/var/lib/inkpipe` holds the SQLite database and the blob store. Keep it off the
repo checkout so a redeploy never touches your data.

## 7. Bootstrap (not yet available)

```bash
sudo bash /var/www/inkpipe/ops/bootstrap-vps.sh
```

Intended to be idempotent: safe to re-run, it checks current state and only
changes what is wrong. It will create the data directories with correct
ownership, write a minimal sudoers entry, install the pm2 service, and validate
the result loudly rather than silently half-succeeding.

## 8. Start and generate a join token (not yet available)

```bash
pm2 start ecosystem.config.cjs
pm2 save

sudo -u inkpipe node /var/www/inkpipe/apps/server/dist/cli.js issue-join-token
```

The token is single use and short lived. Paste it into the desktop setup wizard
along with `https://inkpipe.YOUR_DOMAIN`. The wizard does the rest.

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

**Updates.** `git pull`, `npm ci`, `npm run build --workspace apps/server`,
`pm2 restart inkpipe`.

**Logs.** `pm2 logs inkpipe`.

## If you already run other services on this box

The owner's box already has nginx, Node, pm2, and a `deploy` user from
`saas-backend`. In that case skip steps 1 to 4, add only the new nginx server
block in step 5, and pick a service port that is not already taken. Ports 3010,
3011, 3020, 3021, and 3030 are in use there, which is why inkpipe defaults to
**3040**.

## Threat model reminder

An attacker who fully owns this box gets: a list of device public keys, blob
sizes and timestamps, and ciphertext they cannot read. They do not get your
notes, your vault, or your GitHub credentials, because none of those are ever
here. If you find yourself adding a feature that changes that sentence, stop and
re-read `docs/PREPARATION.md` section 8.
