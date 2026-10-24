param([Parameter(Mandatory=$true)][string]$BackupFile)
$ErrorActionPreference = "Stop"
$resolved = (Resolve-Path -LiteralPath $BackupFile).Path
if (-not $resolved.EndsWith(".dump", [System.StringComparison]::OrdinalIgnoreCase)) { throw "Expected a .dump backup" }
$testDatabase = "aura_restore_test"
$containerTarget = "/tmp/aura_restore_test.dump"
docker compose cp $resolved "postgres:$containerTarget"
if ($LASTEXITCODE -ne 0) { throw "Copying the backup into PostgreSQL failed" }
try {
  docker compose exec -T postgres dropdb -U aura --if-exists $testDatabase
  if ($LASTEXITCODE -ne 0) { throw "Could not prepare restore-test database" }
  docker compose exec -T postgres createdb -U aura $testDatabase
  if ($LASTEXITCODE -ne 0) { throw "Could not create restore-test database" }
  docker compose exec -T postgres pg_restore -U aura -d $testDatabase --exit-on-error $containerTarget
  if ($LASTEXITCODE -ne 0) { throw "Restore test failed" }
  $counts = docker compose exec -T postgres psql -U aura -d $testDatabase -Atc "SELECT (SELECT count(*) FROM users)||' users, '||(SELECT count(*) FROM seasons)||' seasons, '||(SELECT count(*) FROM ledger_transactions)||' ledger transactions';"
  if ($LASTEXITCODE -ne 0) { throw "Restored database verification query failed" }
  docker compose exec -T postgres psql -U aura -d aura_exchange -c "INSERT INTO system_state(key,value,updated_at) VALUES ('restore_test',jsonb_build_object('completedAt',now(),'backup','$([System.IO.Path]::GetFileName($resolved))'),now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Restore succeeded but status recording failed" }
  Write-Output "Restore test passed: $counts"
} finally {
  docker compose exec -T postgres dropdb -U aura --if-exists $testDatabase | Out-Null
  docker compose exec -T postgres rm -f $containerTarget | Out-Null
}
