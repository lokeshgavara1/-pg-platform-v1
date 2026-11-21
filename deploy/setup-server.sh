#!/usr/bin/env bash
# =============================================================================
# One-time setup of a fresh Ubuntu 24.04 server for PGPAL (production settings).
#
#   sudo FIREBASE_PROJECT_ID=<id> bash setup-server.sh <git-repo-url> <branch>
#
# Example:
#   sudo FIREBASE_PROJECT_ID=pg-platform-e8a57 bash setup-server.sh git@github.com:you/your-repo.git staging-deploy
#
# What it does (safe to re-run; it skips steps that are already done):
#   - installs Node.js 22, PostgreSQL, Caddy (automatic HTTPS), git, a firewall
#   - adds swap on small machines so the apps can build
#   - creates the 'pgapp' service user, database, private storage and backup folders
#   - clones the repo (a read-only GitHub deploy key is created for private repos)
#   - writes backend/.env with NEW random secrets (never your laptop's)
#   - installs the systemd service, Caddy config and backup cron, then deploys
#
# Web addresses default to free sslip.io names built from the server's public IP,
# e.g. https://api.13-235-10-20.sslip.io. To use your own domain instead:
#   sudo STAGING_DOMAIN=staging.example.in bash setup-server.sh ...
# Login is "Continue with Google" (free, Firebase). There is no SMS/OTP login and no
# test payment gateway or test e-signature on a server: rent is paid by direct UPI or cash,
# and agreements are signed on paper.
# =============================================================================
set -euo pipefail

REPO_URL="${1:-}"
BRANCH="${2:-}"
if [[ -z "$REPO_URL" || -z "$BRANCH" ]]; then
  echo "Usage: sudo bash setup-server.sh <git-repo-url> <branch>" >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run with sudo." >&2
  exit 1
fi
if [[ -z "${FIREBASE_PROJECT_ID:-}" ]]; then
  echo "Set FIREBASE_PROJECT_ID (your Firebase project id) — it is how everyone logs in:" >&2
  echo "  sudo FIREBASE_PROJECT_ID=pg-platform-e8a57 bash setup-server.sh <git-repo-url> <branch>" >&2
  exit 1
fi

APP_USER=pgapp
APP_DIR=/srv/pg-platform
STORAGE_DIR=/srv/pg-storage
BACKUP_DIR=/srv/pg-backups
CONF_DIR=/etc/pg-platform
DB_NAME=pg_platform

step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "This script is written for Ubuntu (found: ${PRETTY_NAME:-unknown})." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
step "Working out the web addresses"
if [[ -n "${STAGING_DOMAIN:-}" ]]; then
  BASE="$STAGING_DOMAIN"
else
  PUBLIC_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]' || true)"
  if [[ ! "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Could not detect the public IP. Re-run with STAGING_DOMAIN=<domain>." >&2
    exit 1
  fi
  BASE="${PUBLIC_IP//./-}.sslip.io"
fi
API_HOST="api.$BASE"
OWNER_HOST="owner.$BASE"
TENANT_HOST="app.$BASE"
ADMIN_HOST="admin.$BASE"
note "API:    https://$API_HOST"
note "Owner:  https://$OWNER_HOST"
note "Tenant: https://$TENANT_HOST"
note "Admin:  https://$ADMIN_HOST"

# ---------------------------------------------------------------------------
step "Installing packages (PostgreSQL, Caddy, git, firewall)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl ufw postgresql caddy >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v)" != v22.* ]]; then
  step "Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
note "node $(node -v), npm $(npm -v), $(psql --version)"

# ---------------------------------------------------------------------------
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [[ "$MEM_MB" -lt 2500 ]] && ! swapon --show | grep -q .; then
  step "Adding 2 GB swap (this machine has ${MEM_MB} MB RAM; builds need more)"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------------------
step "Firewall: allow only SSH, HTTP and HTTPS"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
note "Port 4000 (the API) is not exposed; Caddy reaches it on 127.0.0.1."

# ---------------------------------------------------------------------------
step "Service user and folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$STORAGE_DIR" "$BACKUP_DIR" "$CONF_DIR"
chown "$APP_USER:$APP_USER" "$STORAGE_DIR" "$BACKUP_DIR"
chmod 700 "$STORAGE_DIR" "$BACKUP_DIR"
if [[ ! -d "$APP_DIR" ]]; then
  mkdir -p "$APP_DIR"
  chown "$APP_USER:$APP_USER" "$APP_DIR"
  chmod 755 "$APP_DIR"
fi

# ---------------------------------------------------------------------------
step "Getting the code"
if [[ ! -d "$APP_DIR/.git" ]]; then
  if [[ "$REPO_URL" == git@* ]]; then
    KEY="/home/$APP_USER/.ssh/id_ed25519"
    if [[ ! -f "$KEY" ]]; then
      sudo -u "$APP_USER" mkdir -p "/home/$APP_USER/.ssh"
      sudo -u "$APP_USER" ssh-keygen -q -t ed25519 -N '' -C "pg-staging-deploy" -f "$KEY"
    fi
    sudo -u "$APP_USER" bash -c "ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null"
    echo
    echo "  Add this READ-ONLY deploy key to your GitHub repo:"
    echo "  GitHub repo -> Settings -> Deploy keys -> Add deploy key (leave 'Allow write access' OFF)"
    echo
    cat "$KEY.pub"
    echo
    read -r -p "  Press Enter after adding the key... " _
  fi
  sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  note "Already cloned at $APP_DIR"
fi

# ---------------------------------------------------------------------------
step "Database"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$APP_USER'" | grep -q 1; then
  note "Database role '$APP_USER' already exists; keeping the existing password in backend/.env"
  DB_PASS=""
else
  DB_PASS="$(openssl rand -hex 24)"
  # CREATEDB lets the weekly restore test build (and drop) a scratch copy.
  sudo -u postgres psql -q -c "CREATE ROLE $APP_USER LOGIN CREATEDB PASSWORD '$DB_PASS'"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  sudo -u postgres createdb -O "$APP_USER" "$DB_NAME"
fi

# ---------------------------------------------------------------------------
step "Backend settings (backend/.env)"
ENV_FILE="$APP_DIR/backend/.env"
if [[ -f "$ENV_FILE" ]]; then
  note "Keeping the existing $ENV_FILE"
else
  if [[ -z "$DB_PASS" ]]; then
    echo "The database role exists but backend/.env is missing. Reset the role password with:" >&2
    echo "  sudo -u postgres psql -c \"ALTER ROLE $APP_USER PASSWORD '<new>'\"  and write backend/.env by hand." >&2
    exit 1
  fi
  secret() { openssl rand -hex 32; }
  umask 077
  cat > "$ENV_FILE" <<EOF
# PGPAL server settings. Generated by deploy/setup-server.sh on $(date -u +%F).
NODE_ENV=production
HOST=127.0.0.1
PORT=4000
DATABASE_URL="postgresql://$APP_USER:$DB_PASS@localhost:5432/$DB_NAME?schema=public"
PUBLIC_BASE_URL=https://$API_HOST
CORS_ORIGINS=https://$OWNER_HOST,https://$TENANT_HOST,https://$ADMIN_HOST
OWNER_APP_URL=https://$OWNER_HOST
TENANT_APP_URL=https://$TENANT_HOST
ADMIN_APP_URL=https://$ADMIN_HOST

JWT_ACCESS_SECRET=$(secret)
JWT_REFRESH_SECRET=$(secret)
OTP_HASH_SECRET=$(secret)
FILE_SIGNING_SECRET=$(secret)

# Login: free "Continue with Google" (Firebase). No SMS/OTP login.
FIREBASE_PROJECT_ID=$FIREBASE_PROJECT_ID
SMS_PROVIDER=none
# Payments: direct UPI to the owner + cash, confirmed by the owner. No online gateway.
PAYMENT_PROVIDER=none
# Agreements: signed on paper; the owner marks them signed.
ESIGN_PROVIDER=none
PUSH_PROVIDER=inapp

STORAGE_DIR=$STORAGE_DIR
JOBS_ENABLED=true
EOF
  umask 022
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  note "Wrote $ENV_FILE with fresh secrets (readable only by $APP_USER)"
fi

cat > "$CONF_DIR/deploy.env" <<EOF
APP_USER=$APP_USER
APP_DIR=$APP_DIR
BRANCH=$BRANCH
API_HOST=$API_HOST
OWNER_HOST=$OWNER_HOST
TENANT_HOST=$TENANT_HOST
ADMIN_HOST=$ADMIN_HOST
EOF
chmod 644 "$CONF_DIR/deploy.env"

# ---------------------------------------------------------------------------
step "Caddy (HTTPS), systemd service and backup schedule"
sed -e "s/{{API_HOST}}/$API_HOST/g" \
    -e "s/{{OWNER_HOST}}/$OWNER_HOST/g" \
    -e "s/{{TENANT_HOST}}/$TENANT_HOST/g" \
    -e "s/{{ADMIN_HOST}}/$ADMIN_HOST/g" \
    "$APP_DIR/deploy/Caddyfile.template" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
install -m 644 "$APP_DIR/deploy/pg-backend.service" /etc/systemd/system/pg-backend.service
install -m 644 "$APP_DIR/deploy/pg-platform.cron" /etc/cron.d/pg-platform
systemctl daemon-reload
systemctl enable pg-backend >/dev/null 2>&1
systemctl enable caddy >/dev/null 2>&1

# ---------------------------------------------------------------------------
step "First deploy (installs dependencies and builds; takes a few minutes)"
bash "$APP_DIR/deploy/deploy.sh"

cat <<EOF

=====================================================================
 PGPAL is set up.

   Owner app:  https://$OWNER_HOST
   Tenant app: https://$TENANT_HOST
   Admin site: https://$ADMIN_HOST
   API health: https://$API_HOST/health

 Next:
   1. Firebase console -> Authentication -> Settings -> Authorized domains:
      add $OWNER_HOST, $TENANT_HOST and $ADMIN_HOST
      (without this the Google button says the address is not allowed).
   2. Create your admin account; it prints a one-time sign-in link:
        sudo -u $APP_USER bash -c 'cd $APP_DIR && npm run admin:create -w backend -- <mobile> "<Your name>"'
      Open the link and "Continue with Google".
   3. PG owners sign up themselves at the owner app with "Continue with Google".
   4. Deploy new code later with:
        sudo bash $APP_DIR/deploy/deploy.sh
=====================================================================
EOF
