# Aura Exchange API: instructions for Claude

This repo is the **server** for Aura Exchange, a play-money social stock market where each friend is a listed stock and prices move on things that happen to them. It started as a friend's web app (`karkys/Aura-Exchange`). We are evolving it, on the branch `aura-v1`, into a multi-exchange cloud API for a separate Flutter iPhone app.

## Read these first (in `docs/aura/`)

| File | What it's for |
| --- | --- |
| `DECISIONS.md` | What's settled, what changed, open questions. **Wins over everything else.** |
| `PLAN.md` | The full game design: price engine, event pipeline, trading, economy, parody layer, data model |
| `API-CONTRACT.md` | Rules for every endpoint: money as strings, freshness, one error shape, status enums, idempotency, realtime |
| `../../openapi/v1.yaml` | The endpoints and schemas. **This is the contract with the app.** |
| `SCREENS.md` | The 32 app screens and which endpoints each needs. Use it to decide priority. |
| `ROADMAP.md` | Milestones for this repo, with acceptance checks. Work top to bottom. |

## Progress and resuming (read this on every start)

Sessions can stop at any moment: usage limits, a crash, a closed laptop. Work so that a fresh session can pick up exactly where the last one stopped, from the repo alone.

- **`docs/aura/PROGRESS.md` is the live log.** Its top block is always current:

  ```markdown
  ## Now
  - Step: 0.2 → idempotency preHandler
  - State: in progress | done | blocked (on what)
  - Next action: the very next concrete thing to do
  - Uncommitted work: none | what's in the working tree and why
  - Waiting on Nathan: questions asked and not yet answered
  ```

  Below it is an append-only log: one dated line per finished step, with its commit hash.
- **Before** starting a step, write what you're about to do into "Now". **After** finishing it, tick the box in `ROADMAP.md`, update "Now", and commit the work with both files. Don't leave a finished step uncommitted.
- **Small commits**, one roadmap sub-step each (smaller for a big one). Local commits are free; pushing still needs Nathan's OK.
- **Every step is safe to repeat.** Check before you create: does the branch, migration, table, route or file already exist? If it does, verify it and move on.
- **On start, and whenever you're asked to resume:**
  1. Read `docs/aura/PROGRESS.md`. If it doesn't exist yet, you're still in 0.1: follow `KICKOFF-API.md` in the handoff, checking what's already done (branch `aura-v1`, the handoff commit) before each step.
  2. Run `git status`, `git branch --show-current` and `git log --oneline -10`.
  3. Compare them. Changes in the tree that "Now" doesn't explain are a half-finished step from a session that was cut off. Read the diff, then either finish it or `git stash push -u -m "interrupted: <what>"` and redo it cleanly. Never discard work.
  4. Re-run the last check (`pnpm check`) before building on top of it.
  5. Continue from "Next action".
- Ask questions in chat **and** record them under "Waiting on Nathan", so they survive a cut-off.
- Before anything long (a big refactor, a dependency upgrade, a long run), write the plan into "Now" first.

## The boundary (most important rule)

- The iPhone app lives in a **different repo** and talks to this server **only** through `/v1` as described in `openapi/v1.yaml` and `API-CONTRACT.md`. Nothing else is shared: no code, no database access.
- **This repo owns the contract.** To change it:
  1. Edit `openapi/v1.yaml`.
  2. Add a line to `openapi/CHANGES.md` (date, what changed, whether the app must update).
  3. Implement it, and make the contract tests pass.
  4. Tell Nathan, so the app session syncs its copy.
- `/v1` only grows. Never rename or remove a field or endpoint. If something must break, discuss `/v2` or a `MIN_APP_BUILD` bump with Nathan first.
- Every `/v1` response must validate against `openapi/v1.yaml`. Keep a contract test (vitest) that calls each implemented route and validates the body with the spec's schemas (e.g. ajv against the components, or `openapi-response-validator`).
- The existing `/api/*` routes and the `web/` console keep working until `/v1` covers what they do. Don't delete them in Phase 0.

## Stack and commands (Windows, PowerShell)

TypeScript (strict), Fastify 5, PostgreSQL 18, `pg`, `zod`, `decimal.js`, `jose`, `argon2`, `vitest`, and pnpm 11 on Node 24.

```powershell
pnpm install
docker compose -f compose.dev.yaml up -d   # dev Postgres on 127.0.0.1:5433 (5432 may be taken by a native install)
pnpm migrate                  # runs db/migrations/*.sql in order
pnpm dev:api                  # http://localhost:8787
pnpm dev:worker               # schedulers, judge, and the engine tick once it exists
pnpm test                     # vitest
pnpm check                    # typecheck + tests + build; must pass before you call anything done
```

`pnpm test` needs the dev Postgres running: `tests/global-setup.ts` drops and recreates `aura_test` and applies every migration on each run. Without Node 24 on the host, run any pnpm command through `powershell -File scripts/pnpm-docker.ps1 <args>` (see `docs/aura/NOTES.md` → Checks).

Mock the app's view of the API from the spec at any time with `npx @stoplight/prism-cli mock openapi/v1.yaml`.

## Where things are

- `src/core/`: pure domain logic.
  - `market.ts`: constant-product AMM, quotes, collateral, liquidation check. Keep it.
  - `ledger.ts`: double-entry cash ledger. Keep it.
  - `price-history.ts`, `aura-voting.ts`.
- `src/routes/`: the existing `/api/*` routes. `src/services/` holds the services behind them.
- `src/worker.ts`: the job queue (judge), schedulers (allowance, dividends, borrow fees, liquidations, ambient motion, index snapshots, season close).
- `src/ai/judge.ts`: the provider-neutral Analyst. `AI_PROVIDER=fake` is deterministic for development.
- `db/migrations/`: numbered SQL migrations. Add new ones as the next number; never edit an applied one.
- `tests/`: domain tests.
- **New code goes in:**
  - `src/v1/` (routes, schemas, serializers)
  - `src/engine/` (the price engine, pure and seeded)
  - `src/realtime/` (WebSocket gateway)
  - `scripts/simulate.ts` (season simulator)

## Non-negotiables

- **Money correctness.**
  - `decimal.js` for every amount, and `numeric(20,8)` in the database. Serialize to 2-dp strings at the edge, through one helper.
  - Never use JS `number` for money.
  - Every cash movement goes through the immutable double-entry ledger.
  - Trades execute only against the exact reserves they were quoted on (`reserveVersion`).
- **Idempotency** on every `/v1` write (`Idempotency-Key` header), stored per user for 24 h. Repeating a key returns the stored response; the same key with a different body returns `409 IDEMPOTENCY_MISMATCH`.
- **One error shape** (`API-CONTRACT.md`) from one Fastify error handler. Throw a typed `AppError(code, httpStatus, params, action, retryable)` and never hand-build error bodies. `params` values are strings.
- **Freshness**: `asOf`, `marketState` and `nextChangeAt` on every payload with prices.
- **Privacy**, enforced in serializers and covered by tests:
  - Event authors are `null` except for the subject and moderators.
  - Positions are private.
  - Whale and liquidation tape items never name the trader.
  - No cross-exchange data.
- **Multi-tenant**: every game query is scoped by `exchange_id`, and a membership check runs on every exchange-scoped route.
- **Engine is pure and seeded.**
  - `src/engine/` functions take state plus an injected RNG and return new state. There is no I/O there.
  - The worker does the I/O.
  - Only one worker ticks at a time (Postgres advisory lock), and one transaction updates all listings in an exchange per tick.
- **Tests with every change.** Domain rules get unit tests; routes get contract tests. Important invariants:
  - The ledger balances.
  - The AMM constant product holds.
  - Liquidation happens at 125%.
  - The m(d) curve matches the table in PLAN.md (impact 10 → 5.4%, 20 → 14.2%, 30 → 25.0%).

## Working rules

- Work on `aura-v1`. Merge `origin/master` into it now and then, because the friend is still working there. Never force-push and never push to `master`. Before the first push to any remote, confirm with Nathan that the friend is OK with the fork (`DECISIONS.md` → open questions).
- Small commits, one milestone step each, with messages that say what and why.
- When the plan is silent or a number looks wrong, don't guess on game rules: write the question into `DECISIONS.md` under "Open questions" and pick the plan's proposed default. Plumbing choices are yours to make; note them in `docs/aura/NOTES.md`.
- Keep `docs/aura/ROADMAP.md` checkboxes current. That file is how Nathan sees progress.
