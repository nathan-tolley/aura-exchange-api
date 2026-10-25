#!/usr/bin/env bash
# Ships the committed tree (HEAD) to the deploy box and (re)starts Caddy, the API, the worker and Postgres with
# Docker Compose. Run from Git Bash. Nothing is pushed to GitHub, and the box keeps its own .env.
#
# Settings come from the environment or a gitignored deploy.local next to this repo's root:
#   DEPLOY_HOST=user@host            required
#   DEPLOY_DOMAIN=tae.app.elicit-marketing.com
#   DEPLOY_KEY=~/.ssh/aura_deploy    the deploy key (key login only; this never prompts for a password)
#   DEPLOY_DIR=aura-exchange         the folder under the remote user's home
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f deploy.local ]; then . ./deploy.local; fi
: "${DEPLOY_HOST:?Set DEPLOY_HOST=user@host in deploy.local or the environment}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-tae.app.elicit-marketing.com}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/aura_deploy}"
DEPLOY_DIR="${DEPLOY_DIR:-aura-exchange}"

box() { ssh -i "$DEPLOY_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$DEPLOY_HOST" "$@"; }

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has changes. Commit first: deploy ships HEAD only." >&2
  exit 1
fi
revision="$(git rev-parse --short HEAD)"

echo "Deploying $revision to $DEPLOY_HOST:~/$DEPLOY_DIR ($DEPLOY_DOMAIN)"
# autocrlf off: ship the committed LF line endings, or the box's sh chokes on CRLF scripts.
git -c core.autocrlf=false archive --format=tar HEAD | box "mkdir -p ~/$DEPLOY_DIR && tar -x -C ~/$DEPLOY_DIR && echo $revision > ~/$DEPLOY_DIR/REVISION"
box "cd ~/$DEPLOY_DIR && sh scripts/box-init-env.sh $DEPLOY_DOMAIN"
box "cd ~/$DEPLOY_DIR && docker compose up -d --build --remove-orphans && docker compose ps"
echo "Deployed $revision. Check it with: pnpm smoke --base https://$DEPLOY_DOMAIN"
