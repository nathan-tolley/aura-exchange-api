#!/bin/sh
# Runs on the deploy box, in the project folder: writes .env once, with fresh random secrets.
# The secrets never leave the box and are never printed. An existing .env is left alone.
# Usage: sh scripts/box-init-env.sh tae.app.elicit-marketing.com
set -eu

domain="${1:?usage: box-init-env.sh <domain>}"
if [ -f .env ]; then
  echo ".env already exists; leaving it alone"
  exit 0
fi

secret() { openssl rand -hex 32; }
umask 077
cat > .env <<EOF
NODE_ENV=production
SITE_ADDRESS=$domain
APP_ORIGIN=https://$domain
POSTGRES_PASSWORD=$(secret)
SESSION_SECRET=$(secret)
SETUP_TOKEN=$(secret)
AUTH_SECRET=$(secret)
AI_PROVIDER=fake
TZ=America/New_York
MIN_APP_BUILD=1
INVITE_URL_BASE=aura-exchange://invite/
EOF
echo "wrote .env for $domain"
