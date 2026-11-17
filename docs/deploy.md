# Deploying the backend (small VM in an India region, no Docker)

Nothing here has been deployed. These are the steps to do it yourself.

## 1. The machine

- One small Linux VM in **Mumbai or Hyderabad** (AWS `ap-south-1`/`ap-south-2`, GCP `asia-south1`, Azure Central India, DigitalOcean BLR1). 2 vCPU / 2–4 GB RAM is plenty for a 3–5 PG pilot.
- Ubuntu 24.04 LTS. Open only ports 22 (your IP), 80 and 443.
- Install Node.js 22 LTS, PostgreSQL 16+, and Caddy (automatic HTTPS):

```bash
sudo apt update && sudo apt install -y postgresql caddy
```

## 2. Database

```bash
sudo -u postgres createuser --pwprompt pgapp
```

```bash
sudo -u postgres createdb -O pgapp pg_platform
```

Keep Postgres listening on localhost only (default).

## 3. App

```bash
git clone <your repo> /srv/pg-platform && cd /srv/pg-platform && npm ci
```

Create `/srv/pg-platform/backend/.env` from `.env.example` with:
- `NODE_ENV=production`, `DATABASE_URL=postgresql://pgapp:<password>@localhost:5432/pg_platform`
- `PUBLIC_BASE_URL=https://api.yourdomain.in`, `CORS_ORIGINS=https://owner.yourdomain.in,https://app.yourdomain.in,https://admin.yourdomain.in`
- Fresh random values for the four secrets (never reuse dev secrets)
- Real `SMS_PROVIDER`, `PAYMENT_PROVIDER=razorpay` + keys + webhook secret, `STORAGE_DIR=/srv/pg-storage` (or an S3 provider)
- `chmod 600 backend/.env`

Then:

```bash
npm run build && npm run db:deploy -w backend
```

## 4. Run as a service (systemd)

`/etc/systemd/system/pg-backend.service`:

```ini
[Unit]
Description=PG Platform backend
After=network.target postgresql.service

[Service]
WorkingDirectory=/srv/pg-platform/backend
ExecStart=/usr/bin/node dist/server.js
Restart=always
User=pgapp
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now pg-backend
```

## 5. HTTPS + static apps (Caddy)

`/etc/caddy/Caddyfile`:

```
api.yourdomain.in {
  reverse_proxy localhost:4000
}
owner.yourdomain.in {
  root * /srv/pg-platform/web/apps/owner-app/dist
  try_files {path} /index.html
  file_server
}
app.yourdomain.in {
  root * /srv/pg-platform/web/apps/tenant-app/dist
  try_files {path} /index.html
  file_server
}
admin.yourdomain.in {
  root * /srv/pg-platform/web/apps/admin-app/dist
  try_files {path} /index.html
  file_server
}
```

Build the apps with `VITE_API_BASE_URL=https://api.yourdomain.in npm run build -w owner-app` (same for tenant/admin). Caddy obtains certificates automatically. Point the payment gateway's webhook at `https://api.yourdomain.in/webhooks/payments/razorpay`.

## 6. Daily backups + restore test

Add to the `pgapp` user's crontab (`crontab -e`) — 02:30 IST daily backup, weekly restore test:

```
30 21 * * * cd /srv/pg-platform/backend && npm run backup >> /var/log/pg-backup.log 2>&1
0 22 * * 0 cd /srv/pg-platform/backend && npm run backup -- --restore-test >> /var/log/pg-backup.log 2>&1
```

Copy `backend/backups/` off the machine every day (e.g. `rclone` to an encrypted bucket in India) — a backup on the same disk is not a backup. Also back up `STORAGE_DIR` (KYC files).

## 7. After deploying

- `curl https://api.yourdomain.in/health` → `{"ok":true,"db":"up"}`
- Log in from a phone with a real SMS OTP; make one sandbox payment; replay its webhook from the gateway dashboard and confirm nothing changes.
