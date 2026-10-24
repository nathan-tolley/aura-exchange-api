# Progress

The live log for the `aura-v1` branch. See `CLAUDE.md` → "Progress and resuming". The "Now" block is always current; the log below it is append-only.

## Now
- Step: 0.2 → idempotency (`idempotency_keys` + preHandler)
- State: in progress
- Next action: migration `012_idempotency_keys.sql`, then a preHandler + onSend pair on `/v1` writes; it needs a DB to test, so the contract-test harness (dev Postgres) may come first
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
