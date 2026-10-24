# Runs pnpm inside node:24 for hosts without Node 24 (pnpm 11 needs Node >= 22.13).
# node_modules and the pnpm store live in Docker volumes so Linux native builds never touch the working tree.
# Usage: powershell -File scripts/pnpm-docker.ps1 install --frozen-lockfile
#        powershell -File scripts/pnpm-docker.ps1 check
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PnpmArgs)

$repo = (Resolve-Path "$PSScriptRoot\..").Path
$databaseUrl = if ($env:DOCKER_DATABASE_URL) { $env:DOCKER_DATABASE_URL } else { "postgres://aura:aura_dev_password@host.docker.internal:5432/aura_exchange" }
$command = "corepack enable && pnpm config set store-dir /pnpm-store >/dev/null && pnpm " + ($PnpmArgs -join " ")

docker run --rm `
  -e CI=true -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e "DATABASE_URL=$databaseUrl" `
  -v "${repo}:/app" -v aura_api_node_modules:/app/node_modules -v aura_pnpm_store:/pnpm-store `
  -w /app node:24-bookworm-slim sh -c $command
exit $LASTEXITCODE
