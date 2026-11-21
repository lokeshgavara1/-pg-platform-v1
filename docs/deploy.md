# Deploying (small VM in an India region, no Docker)

- **Staging, the quick way:** the scripted AWS Lightsail steps directly below. About 30 minutes, mostly waiting.
- **Production / manual:** the numbered sections after that explain each piece by hand.

---

# Staging on AWS Lightsail (scripted)

The server runs the real apps over HTTPS with free `sslip.io` addresses and **production settings** (see the table at the end of this section): everyone logs in with **Continue with Google**, rent is paid by direct UPI or cash, and agreements are signed on paper. No test or sandbox feature is reachable on a server.

The scripts are in [`deploy/`](../deploy): `setup-server.sh` (one time) and `deploy.sh` (every release).

### 1. Create the server (Lightsail console, about 5 minutes)

1. Sign in at https://lightsail.aws.amazon.com and choose **Create instance**.
2. Region **Mumbai (ap-south-1)**. Platform **Linux/Unix**. Blueprint **OS Only → Ubuntu 24.04 LTS**.
3. Plan: **2 GB RAM** (about $12/month) is comfortable; 1 GB also works because the script adds swap, but builds are slower.
4. Name it `pg-staging` and create it.
5. **Networking tab → Create static IP** and attach it to `pg-staging`. Do this before setup: the web addresses are built from the IP, and without a static IP it changes on every restart.
6. **Networking tab → IPv4 Firewall → Add rule → HTTPS (443)**. SSH (22) and HTTP (80) are open by default. Without 443 the site won't load.
7. **Account → SSH keys** (top right menu) → download the default key for Mumbai: `LightsailDefaultKey-ap-south-1.pem`. Save it as `C:\Users\<you>\.ssh\pg-staging.pem`.

### 2. Connect from your PC (Windows PowerShell)

Windows refuses keys that other users can read, so lock the file down once:

```powershell
icacls $env:USERPROFILE\.ssh\pg-staging.pem /inheritance:r /grant:r "$($env:USERNAME):R"
```

Then connect (replace the IP with your static IP):

```powershell
ssh -i $env:USERPROFILE\.ssh\pg-staging.pem ubuntu@13.235.10.20
```

### 3. Run the setup on the server

In the SSH session, fetch the setup script and run it. Use the SSH form of your repo URL (`git@github.com:...`) for a private repo; the script prints a read-only deploy key to add on GitHub and waits for you.

If the repo is **public**:

```bash
curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/staging-deploy/deploy/setup-server.sh -o setup-server.sh
```

If it is **private**, copy the script up from your PC instead (run this in PowerShell on your PC, from the project folder):

```powershell
scp -i $env:USERPROFILE\.ssh\pg-staging.pem deploy\setup-server.sh ubuntu@13.235.10.20:~
```

Then, on the server:

```bash
sudo FIREBASE_PROJECT_ID=pg-platform-e8a57 bash setup-server.sh git@github.com:<you>/<repo>.git staging-deploy
```

It takes 5–10 minutes. At the end it prints your four addresses, for example `https://owner.13-235-10-20.sslip.io`.

**Allow Google sign-in on these addresses (free, 1 minute):** Firebase console → your project → Authentication → Settings → **Authorized domains** → *Add domain* three times: `owner.<ip>.sslip.io`, `app.<ip>.sslip.io`, `admin.<ip>.sslip.io` (use the exact names the script printed). Without this, the Google button says the address is not allowed.

### 4. First login

Create your admin account. The command prints a **one-time sign-in link**:

```bash
sudo -u pgapp bash -c 'cd /srv/pg-platform && npm run admin:create -w backend -- 98XXXXXXXX "Your Name"'
```

Open that link and tap **Continue with Google**; from then on, sign in to the admin site with Google. Run the command again for a fresh link if it expires (7 days).

- **PG owners** sign up themselves at the owner app with *Continue with Google*.
- **Staff**: the owner taps *Login link* next to the staff member (More → Properties & settings) and sends it on WhatsApp.
- **Tenants**: sign up in the tenant app with Google, or the owner taps *Send app login link* on the tenant's page.

The demo data (fake test accounts) is for your laptop only; the seed script refuses to run on a server.

### 5. Releasing new code

Push to the `staging-deploy` branch on GitHub, then on the server:

```bash
sudo bash /srv/pg-platform/deploy/deploy.sh
```

It fast-forwards the code, rebuilds, applies migrations, restarts and checks `/health`. If a step fails, the running site keeps its last good build of the API (the service is only restarted at the end).

### Useful commands on the server

| What | Command |
| --- | --- |
| API status / recent logs | `systemctl status pg-backend` / `journalctl -u pg-backend -n 100` |
| HTTPS / Caddy problems | `journalctl -u caddy -n 50` |
| Backups and the weekly restore-test log | `ls /srv/pg-backups` / `tail -50 /srv/pg-backups/backup.log` |
| Run a backup + restore test now | `sudo -u pgapp bash -c 'cd /srv/pg-platform/backend && BACKUP_DIR=/srv/pg-backups npm run backup -- --restore-test'` |
| Settings (secrets, providers) | `sudo -u pgapp nano /srv/pg-platform/backend/.env`, then `sudo systemctl restart pg-backend` |

Backups stay on the same disk; also turn on **Lightsail automatic snapshots** (instance → Snapshots → Enable automatic snapshots) so you have a copy that survives losing the server.

### What a server runs (production settings)

| Area | On a server | Development-only option (refused on a server) |
| --- | --- | --- |
| Login | Continue with Google (`SMS_PROVIDER=none`) + one-time login links | `SMS_PROVIDER=console` (OTP shown on screen / in the log) |
| Payments | Direct UPI to the owner + cash, confirmed by the owner (`PAYMENT_PROVIDER=none`) | `PAYMENT_PROVIDER=fake` (sandbox checkout) |
| Agreements | Printed and signed on paper; the owner taps *Mark as signed* (`ESIGN_PROVIDER=none`) | `ESIGN_PROVIDER=dev` (OTP test signature) |
| Demo data | Never | `npm run db:seed` |

The backend refuses to start with `NODE_ENV=production` and any development-only option, and there is no override. A real SMS gateway, Razorpay or a legal e-sign provider can be added later behind the same settings.

---

# Manual setup reference

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
