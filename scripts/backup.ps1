param(
  [string]$BackupDirectory = (Join-Path $PSScriptRoot "..\backups")
)

$ErrorActionPreference = "Stop"
$resolvedRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$resolvedBackup = [System.IO.Path]::GetFullPath($BackupDirectory)
if (-not $resolvedBackup.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "BackupDirectory must stay inside the Aura Exchange project directory."
}
New-Item -ItemType Directory -Force -Path $resolvedBackup | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$target = Join-Path $resolvedBackup "aura_$stamp.dump"
$containerTarget = "/tmp/aura_$stamp.dump"

docker compose exec -T postgres pg_dump -U aura -d aura_exchange -Fc -f $containerTarget
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
docker compose cp "postgres:$containerTarget" $target
if ($LASTEXITCODE -ne 0) { throw "Copying the backup from PostgreSQL failed" }
docker compose exec -T postgres rm -f $containerTarget

$dailyCutoff = (Get-Date).AddDays(-14)
$weeklyCutoff = (Get-Date).AddDays(-56)
$files = Get-ChildItem -LiteralPath $resolvedBackup -Filter "aura_*.dump" -File | Sort-Object LastWriteTime -Descending
foreach ($file in $files) {
  $isWeekly = $file.LastWriteTime.DayOfWeek -eq [DayOfWeek]::Sunday
  if ($file.LastWriteTime -lt $dailyCutoff -and (-not $isWeekly -or $file.LastWriteTime -lt $weeklyCutoff)) {
    Remove-Item -LiteralPath $file.FullName
  }
}
Write-Output "Backup complete: $target"

