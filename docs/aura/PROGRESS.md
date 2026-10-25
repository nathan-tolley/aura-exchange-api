# Progress

The live log for the `aura-v1` branch. See `CLAUDE.md` → "Progress and resuming". The "Now" block is always current; the log below it is append-only.

## Now
- Step: 0.7 → deploy to Nathan's Ubuntu box (`tae.app.elicit-marketing.com`)
- State: deployed `947ffc6` on the box and healthy inside it (`/v1/health` OK with a fresh worker heartbeat, reachable from the other Caddy as `aura-exchange-api:8787`); not public yet. SSH works as `<user>` with the deploy key (`deploy.local` has the target). The box (Azure, Ubuntu 24.04, x86_64, 4 CPUs, 15 GB RAM, about 6 GB disk free) already runs another stack, `~/<other-stack>/deploy` (a `<user>` app, Ollama, and a Caddy on 80/443). So ours runs without its own Caddy (`compose.box.yaml`), with the API on that Caddy's network as `aura-exchange-api`.
- Next action: only with Nathan's OK, add the `tae.app.elicit-marketing.com` site block to `~/<other-stack>/deploy/Caddyfile` (another repo, with another contributor) and reload that Caddy; then `pnpm smoke --base https://tae.app.elicit-marketing.com` once DNS resolves
- Uncommitted work: none
- Waiting on Nathan:
  - OK to add one site block to the <other-stack> Caddyfile and reload that Caddy?
  - The DNS A record for `tae.app.elicit-marketing.com` (not live yet at the authoritative server on 2026-10-25).
  - DECISIONS.md open question 12: base daily volatility 2% → 1.1%, so the simulator lands near 60/25/15. The engine default stays at 2% until he agrees.
  - Email provider for sign-in codes (open question 8): not needed for a test exchange (codes go to the host's log), needed before friends sign in.
  - Spec draft.6 (named error examples): tell the app session to sync `api/openapi.yaml` again.
  - Node 24 on the host? pnpm 11.25.0 needs Node ≥ 22.13; the host has 20.20.0. Checks run in a `node:24` container meanwhile (NOTES.md → Checks). Ask before changing the global Node.
  - The fork: is `karkys` OK with it? Nothing gets pushed until then.
  - DECISIONS.md open question 10: prediction markets and options (kept on `/api` only for now).
  - DECISIONS.md open question 11: the exchange size cap (20 members per exchange, `settings.maxMembers`, for now).

## Log
- 2026-10-24 · 0.1 · `git status` on `master`: clean (fresh clone, no `web/` changes). `master` already at `49a0eaf`. Created `aura-v1`.
- 2026-10-24 · 0.1 · Copied the handoff into the repo (`CLAUDE.md`, `docs/aura/*`, `openapi/v1.yaml`, `openapi/CHANGES.md`, this file).
- 2026-10-24 · 0.1 · Wrote `docs/aura/NOTES.md` → What exists (routes, tables, jobs, code-vs-plan differences, contract gaps). Added open question 10 to DECISIONS.md.
- 2026-10-24 · 0.1 · `pnpm install` + `pnpm check` pass on the untouched branch (Node 24 container; 23 tests). 0.1 done.
- 2026-10-24 · 0.2 · `buildApp()` factory in `src/app.ts`; `server.ts` only gates migrations and listens. Added `scripts/pnpm-docker.ps1`. `pnpm check` green.
- 2026-10-24 · 0.2 · Contract `AppError` + one error handler (`/v1` contract shape, `/api` legacy shape); fixed the dead `/api` error handler; 3 additive codes (spec draft.2). 36 tests green.
- 2026-10-24 · 0.2 · `/v1` version gate (426), maintenance mode (503), `GET /v1/health` route (its DB-backed test comes with the harness). 40 tests green.
- 2026-10-24 · 0.2 · Contract-test harness (ajv + openapi/v1.yaml), dev Postgres (`compose.dev.yaml`, port 5433), DB-backed `/v1/health` contract tests. 47 tests green.
- 2026-10-24 · 0.2 · Idempotency (`012_idempotency_keys.sql`, preHandler + onSend, hourly purge); spec draft.3 declares 429/503 everywhere and 400/409 on writes. 61 tests green. **0.2 done.**
- 2026-10-24 · 0.3 · Legacy `/api` smoke test (`tests/legacy/api-smoke.test.ts`, 9 console flows) green on the pre-0.3 schema, as a safety net.
- 2026-10-24 · 0.3 · Migration 013 (exchanges, memberships, `person_stocks` → `listings`, `exchange_id` + `enforce_exchange_id` trigger on every game table); legacy `/api` scoped to the Default exchange; schema tests. 76 tests green.
- 2026-10-24 · 0.3 · Worker per exchange (`src/jobs/schedulers.ts`, migration 014 for run-once keys), failures isolated per exchange, season-close query fixed. 81 tests green.
- 2026-10-24 · 0.3 · `/v1` membership guard (403 NOT_A_MEMBER, 404 for foreign resources), idempotency scoped per user. 88 tests green.
- 2026-10-24 · 0.3 · DB-wide isolation audit (`tests/db/isolation.test.ts`): every season/listing-referencing table has `exchange_id` + trigger, no cross-exchange rows, cross-exchange writes refused. 92 tests green.
- 2026-10-24 · 0.3 · Console-side isolation test (a second exchange, owner listed on both): `/api` shows only Default data and 404s foreign ids; mutation-checked. 94 tests green. **0.3 done.**
- 2026-10-24 · 0.4 · Migration 015 (email users, `login_codes`, `refresh_tokens`), `AUTH_SECRET`, login-code / token / email-sender services. 94 tests green.
- 2026-10-24 · 0.4 · Email-code sign-in, rotating refresh families, bearer guard, `GET /me`; spec draft.4 (`LOGIN_CODE_INVALID`, `LOGIN_CODE_EXPIRED`). 112 tests green. **0.4 done.**
- 2026-10-24 · 0.5 · Market hours per exchange (`src/core/market-hours.ts`), `POST/GET /exchanges`, `GET /exchanges/{id}`, shared views. 122 tests green.
- 2026-10-24 · 0.5 · Invites (create, preview, accept), ticker check, IPO at 4,000/400,000; migration 016; spec draft.5 (5 new codes); DECISIONS open question 11 (member cap 20). 130 tests green.
- 2026-10-24 · 0.5 · `GET /exchanges/{id}/market`, `/listings/{id}`, `/listings/{id}/candles` with freshness, sparkline, AURA index, badges. 136 tests green.
- 2026-10-24 · 0.5 · `POST /quotes` and `POST /trades` (shared `executeTrade` with the console; typed rejections with `maxQuantity`; hours, halts and the 3-listing rule). 149 tests green.
- 2026-10-24 · 0.5 · `GET /exchanges/{id}/portfolio` (net worth incl. reserved cash, season/day change, positions, resting orders). 153 tests green.
- 2026-10-24 · 0.5 · Phase-0 coverage test and the Prism-parity shape check; spec draft.5. 154 tests green. **0.5 done.**
- 2026-10-25 · contract request #1 · Named error examples on `E400`…`E503`, one per code (spec draft.6); a contract test keeps them equal to `errorCodes` and API-CONTRACT.md's params; checked against a real Prism mock. Added open question 11 to "Waiting on Nathan". 155 tests green.
- 2026-10-25 · 0.6 · `src/engine/`: seeded RNG, m(d) and follow-on moves, `tick` / `applyNews` / `moveReserves` / quiet decay; 14 engine tests (the m(d) table, half-lives, gap range, constant product, purity, replay). 169 tests green.
- 2026-10-25 · 0.6 · `scripts/sim/season.ts` (pure, seeded `runSeason`: events with rumors, halts, votes, closed-hours queue and earnings; casual, rumor, chase and value traders through `quoteTrade`; per-source booking) and `pnpm sim` (`--runs`, `--set`, `--sweep`, CSVs in `sim-out/`). A LORE ruling now restarts quiet decay. 172 tests green.
- 2026-10-25 · 0.6 · Tuned: base vol 2% → 1.1% (proposed, DECISIONS.md open question 12; simulator default only, engine default stays 2%) and simulated bets of 5–20% of equity. Full seasons: 57.5 / 26.6 / 15.9 at 15 s ticks (3 seeds), 59.3 / 26.5 / 14.2 at 60 s (5 seeds); plan numbers 57.8 / 17.1 / 25.2. Sensitivity table and assumptions in NOTES.md → Price-engine tuning; 0.7 plan in NOTES.md. 173 tests green. **0.6 done.**
- 2026-10-25 · 0.7 · Hosting decided: Nathan's own Ubuntu box at `tae.app.elicit-marketing.com` (DECISIONS.md). Dockerfile installs with a frozen lockfile; `scripts/box-init-env.sh` (secrets generated on the box), `scripts/deploy.sh` (ships HEAD over SSH with the deploy key, `docker compose up -d --build`), `pnpm smoke`. Waiting on SSH access. 173 tests green.
- 2026-10-25 · 0.7 · Deployed `947ffc6` to the box: Postgres 18, API (migrations on start) and worker up and healthy, beside the box's existing `<other-stack>` stack, which is untouched. Our Caddy is off (`compose.box.yaml`); the API is on that stack's network as `aura-exchange-api`. 4.5 GB disk left. Public HTTPS waits on DNS and Nathan's OK to add a site block to that stack's Caddyfile.
