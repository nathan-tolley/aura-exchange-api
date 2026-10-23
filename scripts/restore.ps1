param([Parameter(Mandatory=$true)][string]$BackupFile)
$ErrorActionPreference = "Stop"
$resolved = (Resolve-Path -LiteralPath $BackupFile).Path
if (-not $resolved.EndsWith(".dump", [System.StringComparison]::OrdinalIgnoreCase)) { throw "Expected a .dump backup" }
$containerTarget = "/tmp/aura_restore.dump"
docker compose cp $resolved "postgres:$containerTarget"
if ($LASTEXITCODE -ne 0) { throw "Copying the backup into PostgreSQL failed" }
docker compose exec -T postgres pg_restore -U aura -d aura_exchange --clean --if-exists $containerTarget
if ($LASTEXITCODE -ne 0) { throw "Restore failed" }
docker compose exec -T postgres rm -f $containerTarget
Write-Output "Restore complete. Restart the app and worker with: docker compose restart app worker"

