param(
  [Parameter(Mandatory=$true)][string]$ExternalBackupDirectory,
  [string]$At = "03:00"
)
$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$scriptPath = Join-Path $PSScriptRoot "backup.ps1"
$external = [System.IO.Path]::GetFullPath($ExternalBackupDirectory)
if ($external -eq $projectRoot) { throw "Choose a backup folder outside the project." }
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -ExternalBackupDirectory `"$external`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName "Aura Exchange Nightly Backup" -Action $action -Trigger $trigger -Settings $settings -Description "Nightly Aura Exchange database backup with external copy" -Force | Out-Null
Write-Output "Installed task 'Aura Exchange Nightly Backup' at $At."
