# Aura Exchange

Aura Exchange is a private, play-money social stock market for a consenting group of coworkers or friends. Each person has an Aura stock; the group can file AI-judged Aura events, trade shares, open collateralized shorts, and watch the collective Aura Composite move.

It is fictional entertainment—not a performance system, factual record, security, gambling product, or thing of monetary value.

## What is implemented

- Invite/claim-code membership, Argon2id passwords, secure cookie sessions, CSRF checks, rate limits, and login lockouts.
- Owner bootstrap, roster management, one-time claim codes, member/moderator/owner roles, and consent-gated listings.
- Administrator-issued password reset codes, locally re-encoded avatars, opt-out/delisting, and mark-price position settlement.
- Anonymous-to-the-public Aura submissions, a 10-per-24-hour daily limit with no separate per-subject cap, duplicate prevention, AI rulings, moderator review, and seven-day subject appeals.
- Immediate community voting on Aura rulings; each net vote changes the original ruling's effect by 10%, with every adjustment recorded in the immutable Aura ledger.
- Provider-neutral judge with an OpenAI Responses API adapter and deterministic fake judge for local development.
- Constant-product AMMs, 15-second reserve-bound quotes, 0.5% fees, stale quote protection, long and short positions, 150% initial collateral, exposure caps, circuit breakers, and automatic maintenance liquidation.
- Immutable double-entry cash ledger, immutable trade and Aura ledgers, weekly allowances/dividends, daily borrow fees, eight-week seasons, index snapshots, and correction entries.
- Responsive exchange dashboard, global tape, trade drawer, portfolio, leaderboards, and moderator operations console.
- Expandable per-person stock history with season/day/week ranges, high and low markers, exact trade catalysts, and clearly separated Aura sentiment context.
- Docker Compose deployment with internal PostgreSQL, worker, Caddy automatic HTTPS, health reporting, and backup/restore scripts.
- Migration-gated startup, stale-job recovery, limit-order lifecycle settlement, immutable season-result snapshots, session revocation, notifications, admin diagnostics/export, and a pilot launch health panel.
- Pooled YES/NO prediction markets with live implied odds, moderator resolution, automatic refunds, per-user exposure limits, and a 2% settlement fee.
- System-issued Aura call and put options with 24-hour or seven-day expiries, live three-strike chains, capped purchases, fixed quotes, and automatic cash settlement.

## Local development

Requirements: Node 24+, pnpm 11+, and PostgreSQL 18 (or Docker Desktop for the complete stack).

1. Copy `.env.example` to `.env` and replace `SESSION_SECRET`, `SETUP_TOKEN`, database credentials, and optionally the OpenAI settings.
2. Create a local `aura_exchange` PostgreSQL database.
3. Run:

   ```powershell
   pnpm install
   pnpm migrate
   pnpm dev
   ```

4. In another terminal, start scheduled and AI work:

   ```powershell
   pnpm dev:worker
   ```

5. Open `http://127.0.0.1:5173`. The first-run form uses `SETUP_TOKEN` to create the owner and first listing.

For a no-cost local judge, keep `AI_PROVIDER=fake`. For the hosted judge, set `AI_PROVIDER=openai`, provide `OPENAI_API_KEY`, and optionally change `AI_MODEL`. The adapter sends only a pseudonymous stock key, the submitted event, and matching glossary entries; it uses structured output and `store: false`.

## Windows self-hosting

1. Install Docker Desktop and ensure it starts with Windows.
2. For a local-only first run, set `SITE_ADDRESS=http://localhost` and `APP_ORIGIN=http://localhost` in `.env`.
3. For public hosting, point a domain or dynamic-DNS hostname at your public IP, then set `SITE_ADDRESS` to the hostname and `APP_ORIGIN=https://hostname.example`.
4. For public hosting, forward TCP ports 80 and 443 plus UDP 443 to this computer. Do not expose PostgreSQL or port 8787.
5. Copy `.env.example` to `.env` and add strong values for `POSTGRES_PASSWORD`, `SESSION_SECRET`, and `SETUP_TOKEN`.
6. Start the stack:

   ```powershell
   docker compose up -d --build
   docker compose ps
   ```

Caddy requests and renews the public certificate, redirects HTTP to HTTPS, and proxies only to the internal app service. App and worker containers restart automatically after a reboot.

## Backups

Run `powershell -File scripts/backup.ps1` nightly with Windows Task Scheduler. The script retains 14 daily backups and Sunday backups for eight weeks. Copy the `backups` folder to a separate drive or encrypted cloud-synced folder; a backup on the same disk is not disaster recovery.

Test a restore before the first real season:

```powershell
powershell -File scripts/restore.ps1 -BackupFile .\backups\aura_YYYY-MM-DD_HHMMSS.dump
docker compose restart app worker
```

For a non-destructive restore drill, use `scripts/test-restore.ps1`; it restores into a temporary `aura_restore_test` database, verifies core record counts, records the successful drill in Operations, and removes the temporary database. See [the pilot runbook](docs/PILOT-RUNBOOK.md) for backup scheduling, public-IP precautions, and incident response.

## Verification

```powershell
pnpm check
```

This runs strict server/client type checks, domain tests, and production builds. The most important invariants—AMM math, order limits, collateral thresholds, indices, and ledger balancing—have focused tests under `tests/`.

## Operational notes

- The public feed serializer removes Aura author identity unless the viewer is the subject or a moderator.
- AI outages retry twice and then create a human-review ruling without changing Aura.
- Trades are idempotent and execute only against the exact reserves used to produce their quote.
- Open predictions refund and open options settle at the current mark before a season closes, so no contract value is stranded across resets.
- Permanent history still supports safety removal, account deletion, and withdrawal of consent.
- A production launch should begin with the documented 5–8 person pilot and a completed backup restore test.

