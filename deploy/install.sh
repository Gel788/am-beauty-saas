#!/usr/bin/env bash
# One-command install or update of AM Beauty CRM on a fresh Ubuntu/Debian server.
#   curl -fsSL https://raw.githubusercontent.com/Gel788/am-beauty-saas/staging/deploy/install.sh | sudo bash
# Options (env): BRANCH=staging  DIR=/opt/am-beauty-saas  DOMAIN=<your domain>  ADMIN_EMAIL=<platform owner>  SEED=1|0
# Without DOMAIN the server gets a free name <ip>.sslip.io with a real HTTPS certificate.
set -euo pipefail

BRANCH="${BRANCH:-staging}"
REPO="https://github.com/Gel788/am-beauty-saas.git"
say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }

say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq ca-certificates curl git openssl >/dev/null
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git >/dev/null; }
docker compose version >/dev/null

# An install made earlier (by hand or by another tool) is updated in place, keeping its .env and data.
if [ -z "${DIR:-}" ]; then
  found="$(find /opt /root /srv /home -maxdepth 3 -path '*/deploy/docker-compose.prod.yml' 2>/dev/null | head -1 || true)"
  DIR="${found:+$(dirname "$(dirname "$found")")}"
  DIR="${DIR:-/opt/am-beauty-saas}"
fi
FRESH=0
say "Code: $BRANCH → $DIR"
if [ -d "$DIR/.git" ]; then
  cd "$DIR"
  git stash push -u -m "before install.sh $(date +%F_%H%M)" >/dev/null 2>&1 || true
  git fetch -q origin "$BRANCH"
  git checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  FRESH=1
  git clone -q -b "$BRANCH" "$REPO" "$DIR"
  cd "$DIR"
fi

ENV=deploy/.env
IP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
[ -f "$ENV" ] || { cp deploy/.env.example "$ENV"; FRESH=1; }
set_env() { # key value: set only when empty or a placeholder
  local cur; cur="$(grep -E "^$1=" "$ENV" | head -1 | cut -d= -f2- || true)"
  if ! grep -qE "^$1=" "$ENV"; then echo "$1=$2" >> "$ENV"
  elif [ -z "$cur" ] || [[ "$cur" == change-me* ]] || [ "$cur" = "crm.example.ru" ]; then sed -i "s|^$1=.*|$1=$2|" "$ENV"; fi
}
cur_domain="$(grep -E '^DOMAIN=' "$ENV" | cut -d= -f2- || true)"
if [ -n "${DOMAIN:-}" ]; then sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" "$ENV"
elif [ -z "$cur_domain" ] || [ "$cur_domain" = "crm.example.ru" ] || [[ "$cur_domain" =~ ^[0-9.]+$ ]]; then
  sed -i "s|^DOMAIN=.*|DOMAIN=$IP.sslip.io|" "$ENV"   # HTTPS needs a name; sslip.io maps it to this IP
fi
set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
set_env APP_DB_PASSWORD "$(openssl rand -hex 24)"
set_env JOBS_TOKEN "$(openssl rand -hex 24)"
set_env INTEGRATIONS_KEY "$(openssl rand -hex 32)"
set_env TELEGRAM_WEBHOOK_SECRET "$(openssl rand -hex 16)"
set_env PLATFORM_ADMIN_EMAILS "${ADMIN_EMAIL:-olga@ambeauty.local}"
chmod 600 "$ENV"
DOMAIN_NOW="$(grep -E '^DOMAIN=' "$ENV" | cut -d= -f2-)"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

busy="$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v docker-proxy || true)"
if [ -n "$busy" ]; then
  echo "Ports 80/443 are taken by something other than Docker:"; echo "$busy"
  echo "Stop it (for example: systemctl stop nginx apache2; pm2 stop all) and run this script again."; exit 1
fi

C="docker compose -f deploy/docker-compose.prod.yml --env-file $ENV"
say "Build (a few minutes the first time)"
$C build
say "Database"
$C up -d postgres
$C run --rm migrate
SEED="${SEED:-$FRESH}"
if [ "$SEED" = 1 ]; then
  say "Demo data"
  $C run --rm migrate node scripts/seed.mjs
fi
say "Start"
$C up -d --remove-orphans

for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1/api/health" -H "Host: $DOMAIN_NOW" >/dev/null 2>&1 || curl -fsSk "https://$DOMAIN_NOW/api/health" >/dev/null 2>&1; then break; fi
  sleep 3
done
say "Done"
echo "CRM:        https://$DOMAIN_NOW"
[ "$SEED" = 1 ] && echo "Demo login: olga@ambeauty.local / ambeauty"
echo "Platform:   https://$DOMAIN_NOW/platform  (for $(grep -E '^PLATFORM_ADMIN_EMAILS=' "$ENV" | cut -d= -f2-))"
echo "Health:     $(curl -fsSk "https://$DOMAIN_NOW/api/health" 2>/dev/null || echo 'certificate is still being issued, try again in a minute')"
