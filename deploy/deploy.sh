#!/usr/bin/env bash
# =============================================================================
# Deploy the latest code from the configured branch and restart the API.
#
#   sudo bash /srv/pg-platform/deploy/deploy.sh
#
# Steps: fast-forward the checkout, install dependencies, build the three apps
# (pointing them at this server's API) and the backend, apply database
# migrations, restart the API, and wait for /health.
# Everything runs as the 'pgapp' user except the service restart.
# =============================================================================
set -euo pipefail

# Wrapped in a function so bash reads the whole script before 'git pull' can change it.
main() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Please run with sudo." >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  source /etc/pg-platform/deploy.env

  as_app() { sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && $*"; }
  step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

  step "Updating code from origin/$BRANCH"
  as_app "git fetch --quiet origin '$BRANCH' && git checkout --quiet '$BRANCH' && git merge --ff-only --quiet 'origin/$BRANCH'"
  local rev
  rev="$(as_app 'git log -1 --format="%h %s"')"
  echo "    now at: $rev"

  step "Installing dependencies"
  as_app "npm ci --no-audit --no-fund --loglevel=error"

  step "Building the web apps"
  local vite_env="VITE_API_BASE_URL=https://$API_HOST VITE_TENANT_APP_URL=https://$TENANT_HOST"
  for app in owner-app tenant-app admin-app; do
    as_app "$vite_env npm run build -w $app --silent > /dev/null"
    echo "    built $app"
  done

  step "Building the backend and applying database migrations"
  as_app "npm run build -w backend --silent"
  as_app "cd backend && npx prisma migrate deploy"

  step "Restarting the API"
  systemctl restart pg-backend
  systemctl reload caddy || systemctl restart caddy

  local ok=""
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 http://127.0.0.1:4000/health >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [[ -z "$ok" ]]; then
    echo "The API did not become healthy. Last log lines:" >&2
    journalctl -u pg-backend -n 40 --no-pager >&2
    exit 1
  fi
  echo "    API healthy on 127.0.0.1:4000"

  if curl -fsS --max-time 10 "https://$API_HOST/health" >/dev/null 2>&1; then
    echo "    HTTPS OK: https://$API_HOST/health"
  else
    echo "    HTTPS not answering yet. On the first deploy Caddy may still be getting certificates (up to a minute)."
    echo "    If it stays down: check that port 443 is open in the Lightsail firewall, then: journalctl -u caddy -n 50"
  fi

  step "Deployed $rev"
}

main "$@"
