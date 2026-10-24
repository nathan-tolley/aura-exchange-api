# API roadmap

Work top to bottom. Tick a box only when its check passes and `pnpm check` is green. Phases and gates come from `PLAN.md` → Roadmap. The live state (current step, next action, open questions) is in `PROGRESS.md`.

## Phase 0: fork and foundation

### 0.1 Branch and understand
- [x] `git status` on `master`.
  - There were **uncommitted local changes in `web/`** (icons.tsx, main.tsx, styles.css, tsconfig.json, vite.config.ts) when this was written.
  - **Stop and ask Nathan** whether to stash, commit or discard them. Don't decide alone.
  - 2026-10-24: the fresh clone was clean; nothing to stash.
- [x] `git pull origin master` to get the friend's latest API work, then `git switch -c aura-v1`.
- [x] Copy the handoff into the repo:
  - `CLAUDE.md` goes to the root.
  - `DECISIONS.md`, `PLAN.md`, `API-CONTRACT.md`, `SCREENS.md` and `ROADMAP.md` go in `docs/aura/`.
  - `openapi.yaml` goes to `openapi/v1.yaml`, with a new `openapi/CHANGES.md`.
  - Start `docs/aura/PROGRESS.md` (see `CLAUDE.md` → Progress and resuming).
  - Commit this on its own.
- [x] Read the friend's new code since `5cb2b21` and write `docs/aura/NOTES.md` → "What exists".
  - List every route, table and job, and map each to the `/v1` operation or engine piece it becomes (keep / adapt / replace / drop).
- [x] Run the existing tests. **Check:** `pnpm check` passes on the untouched branch, or the failures are written down in NOTES.md.
  - 2026-10-24: passes (run in a Node 24 container; see NOTES.md → Checks).

### 0.2 Error shape, idempotency, versioning plumbing
- [x] `AppError` and one error handler producing the `API-CONTRACT.md` shape. Map the existing `badRequest`/`forbidden` helpers onto it.
- [x] Middleware that reads `X-App-Version` / `X-App-Build` and returns `426 UPDATE_REQUIRED` below `MIN_APP_BUILD` (env, default 1).
- [x] Idempotency: an `idempotency_keys` table and a preHandler for all `/v1` writes.
- [x] `GET /v1/health`.
- [x] Contract-test harness: load `openapi/v1.yaml` and validate the response of every implemented route.
- **Check:** contract tests for `/health` and two error codes pass.
  - 2026-10-24: passes. `/health` 200 (OK, DEGRADED, MAINTENANCE), `426 UPDATE_REQUIRED`, `400 VALIDATION` and `409 IDEMPOTENCY_MISMATCH` / `IDEMPOTENCY_IN_PROGRESS` all validate against `openapi/v1.yaml`.

### 0.3 Multi-tenancy
- [x] Migration: `exchanges` (name, timezone, hours, settings), `memberships` (user ↔ exchange, role, consent, opt-out), and `listings` (from `person_stocks`, per exchange).
  - Add `exchange_id` to every game table.
  - Backfill the existing data as one exchange ("Default").
- [x] Every query and service is scoped by exchange; there is a membership guard.
- [ ] `minListingsToOpen` (default 3): trading is disabled until it's reached (`tradingEnabled: false` on the market).
- **Check:** a test with two exchanges proves that no data crosses between them.

### 0.4 Token auth
- [ ] Email one-time codes: a `login_codes` table with hashed codes, a 10-minute expiry and 5 attempts.
  - In development the code is logged instead of emailed; the email provider sits behind an interface.
- [ ] `jose` access tokens (15 min) and rotating refresh-token families (reusing a token revokes the family).
- [ ] Bearer auth on `/v1`. Cookies and CSRF stay only for `/api` and the web console.
- [ ] `/auth/email/start`, `/auth/email/verify`, `/auth/refresh`, `/auth/logout`, `GET /me`.
- **Check:** contract tests pass, and a test shows that reusing a refresh token revokes the family.

### 0.5 /v1 read and trade endpoints (x-phase 0 in the spec)
- [ ] Exchanges: create, list and get; invites (create, preview, accept); ticker check; IPO with consent.
- [ ] Market data: `/exchanges/{id}/market` (with sparkline and freshness), `/listings/{id}`, `/listings/{id}/candles` (with event markers).
- [ ] Trading: `/quotes` (with `previous` when requoting, and the `short` block with liquidation price), `/trades` (`QUOTE_STALE` with old/new price), `/exchanges/{id}/portfolio`.
- [ ] Rejections come back as the right codes with the params the app needs: `INSUFFICIENT_CASH` must include `maxQuantity`.
- **Check:** every x-phase 0 operation passes its contract test, and the Prism mock and the real server return the same shapes.

### 0.6 Price-engine simulator
- [ ] `src/engine/`: m(d) curve, fair value F = B×H with a 3-day hype half-life, gap of 40–120% plus 45-minute drift, mean reversion (2-day half-life), Student-t noise (df 4), the volatility spike, and re-solving AMM reserves to a target price.
  - All of it is pure and seeded.
- [ ] `scripts/simulate.ts` (`pnpm sim`):
  - Replays a fake 8-week season for 6–8 listings with random events and trades.
  - Prints the share of price movement from events / trades / noise, plus summary charts as CSV.
- **Check (Gate 0, part 1):** the simulator lands near **60/25/15**. The tuning that got there is written in NOTES.md.

### 0.7 Cloud
- [ ] Ask Nathan which host (Fly.io, Railway or Render). Deploy the API and worker containers with managed Postgres in US-East, with migrations running on deploy.
- **Check (Gate 0, part 2):** a test exchange runs in the cloud, and the app's dev build can point at it.

## Phase 1: the core loop

- [ ] **Engine tick** in the worker: every 15 s in PRE/OPEN/AFTER.
  - Uses the advisory lock, writes `market_price_ticks`, and replaces `applyAmbientMarketMotion`.
  - Rolls up 1-minute and 1-hour candles; keeps raw ticks for 7 days.
- [ ] **Market hours** per exchange timezone: queue rulings while CLOSED and apply them as one opening gap at pre-market.
- [ ] **Halts**: single-stock limit up/down (10% in 5 minutes → 5-minute halt), news halts, the market-wide breaker (−7% → 15 min; −20% → closed until the next open).
- [ ] **Event pipeline**:
  - SENDING (30 s unsend) → RUMOR (10 min, Analyst teaser) → co-signs and caps (±10% each, capped at ±30%) → subject statement (denial plus a confirmed loss adds 20%) → RULING → RULED, HALTED or REVIEW.
  - Insider windows run until 30 minutes after the ruling.
- [ ] **The Analyst** returns verdict, impact, confidence, category, headline (≤90), analyst note (≤280) and policy flags. Extend `src/ai/judge.ts`; the fake provider returns realistic canned output.
- [ ] Up/down votes (2 h, ±10% each, capped at ±50%) with a `conflicted` flag; halt votes (30 min; Confirm / Decline / Reconsider; A$100 reward); appeals.
- [ ] Orders: limit buy/sell, stop-loss and take-profit, all checked every tick. Only limit orders are allowed in PRE/AFTER (1.5% fee).
- [ ] Margin: `ShortDetail` on positions, the 140% warning notification, and a liquidation receipt (`LIQUIDATED` notification plus a tape item that names no one).
- [ ] Uploads: signed URLs to object storage for receipts, images re-encoded with `sharp`.
- [ ] Tape: `/exchanges/{id}/tape` with all Phase 1 item types.
- [ ] Notifications: write a `Notification` row for every trigger in `API-CONTRACT.md`. Serve `/me/notifications`, `/read` and the prefs endpoints, and respect quiet hours (margin calls always get through).
- [ ] **Realtime** `/v1/stream`: `@fastify/websocket` fed by Postgres LISTEN/NOTIFY, carrying ticks (changed listings only), tape, status, notifications and market-state messages.
- **Check (Gate 1):** the break-it checklist in `PLAN.md` → Quality bar passes against the real server:
  - airplane mode mid-trade
  - stale quote
  - liquidation
  - empty exchange
  - halted stock
  - closed market
  - a brutal roast

## Phase 2 (drafted in the spec, `x-phase: 2`)
SEC and insider cases, the Sunday 13F reveal, weekly earnings, analyst ratings, opening and closing bell, splits and Chapter 11, super-injunctions, bankruptcy, season awards, report, block and the moderation queue.
