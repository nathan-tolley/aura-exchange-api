#!/usr/bin/env bash
# Ships the committed tree (HEAD) to the deploy box and (re)starts Caddy, the API, the worker and Postgres with
# Docker Compose. Run from Git Bash. Nothing is pushed to GitHub, and the box keeps its own .env.
#
# Settings come from the environment or a gitignored deploy.local next to this repo's root:
#   DEPLOY_HOST=user@host            required
#   DEPLOY_DOMAIN=tae.app.elicit-marketing.com
#   DEPLOY_KEY=~/.ssh/aura_deploy    the deploy key (key login only; this never prompts for a password)
#   DEPLOY_DIR=aura-exchange         the folder under the remote user's home
#   DEPLOY_COMPOSE_FILE=compose.yaml:compose.box.yaml   when another stack's Caddy owns 80/443 (see compose.box.yaml)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f deploy.local ]; then . ./deploy.local; fi
: "${DEPLOY_HOST:?Set DEPLOY_HOST=user@host in deploy.local or the environment}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-tae.app.elicit-marketing.com}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/aura_deploy}"
DEPLOY_DIR="${DEPLOY_DIR:-aura-exchange}"
DEPLOY_COMPOSE_FILE="${DEPLOY_COMPOSE_FILE:-compose.yaml}"
# The image build needs about 2 GB; stop well before the disk fills and takes other services on the box down with it.
MIN_FREE_KB=3000000

box() { ssh -i "$DEPLOY_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$DEPLOY_HOST" "$@"; }

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has changes. Commit first: deploy ships HEAD only." >&2
  exit 1
fi
revision="$(git rev-parse --short HEAD)"

free_kb="$(box "df --output=avail -k ~ | tail -1" | tr -d ' ')"
if [ "$free_kb" -lt "$MIN_FREE_KB" ]; then
  echo "Only $((free_kb / 1024)) MB free on the box; the build needs about 2 GB. Free some space first." >&2
  exit 1
fi

echo "Deploying $revision to $DEPLOY_HOST:~/$DEPLOY_DIR ($DEPLOY_DOMAIN, $DEPLOY_COMPOSE_FILE)"
# autocrlf off: ship the committed LF line endings, or the box's sh chokes on CRLF scripts.
git -c core.autocrlf=false archive --format=tar HEAD | box "mkdir -p ~/$DEPLOY_DIR && tar -x -C ~/$DEPLOY_DIR && echo $revision > ~/$DEPLOY_DIR/REVISION"
box "cd ~/$DEPLOY_DIR && sh scripts/box-init-env.sh $DEPLOY_DOMAIN"
box "cd ~/$DEPLOY_DIR && export COMPOSE_FILE=$DEPLOY_COMPOSE_FILE && docker compose up -d --build --remove-orphans && docker compose ps"
echo "Deployed $revision. Check it with: pnpm smoke --base https://$DEPLOY_DOMAIN"
