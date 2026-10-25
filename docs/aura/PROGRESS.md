# Progress

The live log for the `aura-v1` branch. See `CLAUDE.md` → "Progress and resuming". The "Now" block is always current; the log below it is append-only.

## Now
- Step: 0.4 → token auth: migration `015_token_auth.sql`
- State: not started (0.3 done)
- Next action: follow NOTES.md → Plan for 0.4: migration 015 (`users.email`, `users.display_name`, nullable `username`/`password_hash`, `login_codes`, `refresh_tokens`), then `/auth/email/start` + `/verify` (dev: log the code), `/auth/refresh` with family revocation on reuse, `/auth/logout`, the bearer guard setting `request.v1User` (and skipping the cookie Origin check on `/v1`), `GET /me`
- Uncommitted work: none
- Waiting on Nathan:
  - Node 24 on the host? pnpm 11.25.0 needs Node ≥ 22.13; the host has 20.20.0. Checks run in a `node:24` container meanwhile (NOTES.md → Checks). Ask before changing the global Node.
  - The fork: is `karkys` OK with it? Nothing gets pushed until then.
  - DECISIONS.md open question 10: prediction markets and options (kept on `/api` only for now).

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
