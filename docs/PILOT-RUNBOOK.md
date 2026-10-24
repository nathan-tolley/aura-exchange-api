# Aura Exchange pilot runbook

## Before inviting anyone

1. Run `docker compose up -d --build` and confirm all four services are healthy with `docker compose ps`.
2. Open Operations and require green database, migration, worker, scheduler, AI, and backup checks. HTTP transport is intentionally warning-only during the trusted pilot.
3. Install the nightly task with `powershell -File scripts/install-backup-task.ps1 -ExternalBackupDirectory "D:\AuraBackups"`. Use a real external or synced folder.
4. Run the task once from Task Scheduler, then confirm the local and external `.dump` files exist.
5. Verify one backup without touching production: `powershell -File scripts/test-restore.ps1 -BackupFile .\backups\aura_YYYY-MM-DD_HHMMSS.dump`.
6. Use a unique Aura Exchange password. Public HTTP does not encrypt credentials or submissions.
7. Export application data from Operations and retain it with the backup.

## Router and Windows

- Forward only external TCP 8080 to this computer's TCP 80. Never expose ports 5432, 8787, or 1455.
- Allow inbound TCP 80 only for the Docker/Caddy path. Disable router remote administration from the internet.
- Keep Docker Desktop configured to start with Windows. Services use `restart: unless-stopped`.
- If the public IP changes, send participants the new address. Move to a hostname plus HTTPS before broadening access.

## Daily checks

- Review Operations for failed jobs, stale backups, pending migrations, or a missing worker heartbeat.
- Resolve failed AI filings from the review queue; never edit applied ledger rows directly.
- Investigate any ledger or schema error before reopening trading.

## End the paper pilot

Run `docker compose exec -e PILOT_RESET_CONFIRM=RESET-PILOT app node dist-api/scripts/pilot-reset.js`. This asks the worker to settle positions, release open orders, archive the pilot standings, reset seasonal Aura, grant fresh starting balances, and open the next eight-week season. It preserves accounts and immutable pilot history.

## Incident response

1. Remove the router forwarding rule to stop public access.
2. Preserve logs with `docker compose logs --since 24h > incident.log`.
3. Export application data and create a fresh backup.
4. Rotate `SESSION_SECRET`, `SETUP_TOKEN`, and affected passwords, then revoke active sessions.
5. Restore only after preserving the current database and identifying the failure.

## HTTPS exit gate

Before inviting beyond the trusted pilot, obtain a hostname, set `SITE_ADDRESS` to it and `APP_ORIGIN` to its `https://` URL, forward ports 80 and 443, rebuild, and confirm the Transport check turns green.
