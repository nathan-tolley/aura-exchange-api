# Notes

Working notes for the `aura-v1` branch: what the friend's code already does, how each piece maps to `/v1`, plumbing choices, and check results. Game rules live in `PLAN.md` and `DECISIONS.md`, not here.

Verdicts used below:

- **keep**: works as is for `/v1` (maybe plus `exchange_id`).
- **adapt**: the logic carries over, but the shape, scope or numbers change.
- **replace**: `/v1` does this a different way; the old version stays only for `/api` and the web console until `/v1` covers it.
- **drop**: removed once nothing depends on it. Nothing is deleted in Phase 0 (`CLAUDE.md`: `/api` and `web/` keep working).

## What exists

Read on 2026-10-24 at `49a0eaf` (master). About 4,400 lines of server TypeScript, SQL and scripts, plus the React console in `web/`.

### What changed since `5cb2b21`

One commit by the friend, `49a0eaf` "Add pilot hardening, predictions, and options" (41 files, +924/−53):

- **Pilot hardening.**
  - The server refuses to start while migrations are pending (`migration-service.ts`).
  - The worker recovers jobs stuck in `RUNNING` for more than 5 minutes.
  - Sessions record user agent and IP and can be revoked (`/api/auth/sessions`, `.../revoke`).
  - New in-app `notifications` table, written on rulings, Aura Farming results, liquidations, limit fills, prediction results and option settlements.
  - Season close now snapshots standings into `season_results`, settles every open position at the last price and releases open limit orders.
  - Delisting also releases that stock's open limit orders (`limit-order-lifecycle.ts`).
  - Admin job diagnostics, a full JSON export, and a bigger `/api/health` (migrations, worker heartbeat, scheduler, jobs, AI, backups, transport).
  - Ledger: rounding moved into `normalizeBalancedPostings`, which uses half-even rounding and absorbs at most a 1e-8 residue; it's now unit-tested.
  - A non-browser origin check: a write whose `Origin` header doesn't match `APP_ORIGIN` gets a 403.
  - Ops scripts: backup scheduling, a restore drill, `pilot-reset.ts`, and `docs/PILOT-RUNBOOK.md`.
- **Prediction markets** (new game feature): pooled YES/NO questions created by moderators, A$10–1,000 per bet, A$2,000 exposure cap, 2% settlement fee, refunds on cancel or at season close.
- **Options** (new game feature): system-issued calls and puts at three strikes (spot ±10%), 1-day or 1-week expiry, 5-second quotes, a cap of 25% of cash per purchase, and cash settlement at the AMM spot price.

Neither predictions nor options are in the `/v1` contract. PLAN.md puts options in Phase 3 and doesn't mention prediction markets at all. Both stay on `/api` for the web console, and I added an open question to `DECISIONS.md` (#10).

### Routes

All existing routes use cookie sessions. Every write needs `X-CSRF-Token`. There is one global market and one active season.

| Method + path | Auth | What it does | Becomes in `/v1` | Verdict |
| --- | --- | --- | --- | --- |
| `GET /healthz` | none | DB ping for the Docker healthcheck | `GET /health` (status + `minBuild`) | adapt (keep `/healthz` for the container) |
| `GET /api/health` | mod | Ops panel: DB, migrations, worker, scheduler, jobs, AI, backups | Nothing (admin only); `/health` covers the app | keep for the console |
| `GET /api/setup/status`, `POST /api/setup/bootstrap` | setup token | Creates the first OWNER, their stock, season 1 and the first grant | `POST /exchanges` (creator becomes admin) + IPO | replace |
| `POST /api/auth/login` | none | Username + password (argon2id, 5 tries then a 15-minute lockout) | `POST /auth/email/start` + `/auth/email/verify` | replace (keep for the console) |
| `POST /api/auth/claim` | claim code | Creates a user from a stock's claim code, activates the stock, grants A$10,000 | `POST /invites/{code}/accept`, then `POST /exchanges/{id}/listing` | replace |
| `POST /api/auth/reset` | reset code | Password reset from an admin-issued code | Not needed (email codes) | keep for the console |
| `GET /api/auth/session` | user | Current user + their stock | `GET /me` | replace |
| `GET /api/auth/sessions`, `POST /api/auth/sessions/:id/revoke` | user | List and revoke cookie sessions | Refresh-token families (revoke on logout or reuse) | keep for the console |
| `POST /api/auth/logout` | user | Deletes the session | `POST /auth/logout` (revokes the refresh family) | replace |
| `POST /api/aura-events` | user | File an event (8–800 chars, 10 per author per 24 h, exact-duplicate guard); queues `JUDGE_AURA` | `POST /events` (SENDING → RUMOR …) | adapt |
| `POST /api/aura-events/:id/appeal` | subject | Appeal within 7 days | `POST /events/{id}/appeal` | adapt |
| `GET /api/moderation/review`, `POST /api/moderation/review/:id` | mod | Review queue; APPROVE / ADJUST / REJECT / OVERTURN / RETRY | Phase 2 moderation queue; Phase 1 uses the console | keep for the console |
| `POST /api/feed/:id/vote` | user | Up/down vote on a ruling, ±10% of \|delta\| per vote, uncapped | `POST /events/{id}/votes` (capped ±50%, `conflicted` flag) | adapt |
| `GET /api/aura-farming`, `POST /api/aura-farming/:id/vote` | user | Polls on rulings over 15 points: SUPPORT / DECLINE / RECONSIDER | Halts: `POST /halts/{id}/votes` (Confirm / Decline / Reconsider) | adapt |
| `GET /api/market` | user | All active stocks: price, day/season change, aura, halt; Aura Composite and market index | `GET /exchanges/{id}/market` (+ sparkline, freshness, `tradingEnabled`) | adapt |
| `GET /api/composite` | user | Aura Composite history from `index_snapshots` | `GET /exchanges/{id}/index/candles` (Phase 1) | adapt |
| `GET /api/stocks/:id/history` | user | Replayed trade history + raw ticks + the last 20 rulings | `GET /listings/{id}` + `/listings/{id}/candles` (server-side candles with event markers) | replace (candles are built client-side today, in `web/src/candles.ts`) |
| `GET /api/portfolio` | user | Cash, equity, positions with P&L (JSON numbers) | `GET /exchanges/{id}/portfolio` (decimal strings, `ShortDetail`) | adapt |
| `POST /api/trades/preview` | user | Dry-run quote with `canExecute`/`reason` and cash/position before and after | Folded into `POST /quotes` (rejections become typed errors) | replace |
| `POST /api/trades/quote` | user | Stores a 15 s quote pinned to `reserveVersion` | `POST /quotes` (+ `previous` on requote, `short` block) | adapt |
| `POST /api/trades/execute` | user | Executes a quote; idempotent on `(user, idempotencyKey)` in the body | `POST /trades` with an `Idempotency-Key` header | adapt |
| `POST /api/positions/:id/close` | user | Returns a closing quote (doesn't execute) | `POST /positions/{id}/close` (Phase 1) | adapt |
| `GET/POST /api/limit-orders`, `POST /api/limit-orders/:id/cancel` | user | Buy/sell limits; buy cash reserved in escrow; filled by the worker | `GET /exchanges/{id}/orders`, `POST /orders`, `DELETE /orders/{id}` (+ stop-loss / take-profit) | adapt |
| `GET /api/feed` | user | The last 100 feed events; author hidden unless you're the subject or a mod | `GET /exchanges/{id}/tape` (+ `/exchanges/{id}/events`) | adapt (see the privacy gaps below) |
| `GET /api/leaderboards` | user | Top 25 by aura and by net worth | `GET /exchanges/{id}/leaderboards` (Phase 2) | adapt |
| `GET /api/notifications`, `POST /api/notifications/:id/read` | user | The last 50 notifications + unread count | `GET /me/notifications`, `POST /me/notifications/read` (Phase 1) | adapt |
| `POST /api/profile/avatar` | user | Multipart image, re-encoded to 512² WebP with sharp, saved to `uploads/` | `POST /uploads` (signed URL) + `PATCH /me` | replace |
| `POST /api/profile/opt-out` | user | Delists yourself, cashing holders out at the last price | `DELETE /exchanges/{id}/listing` (Phase 1) | adapt |
| `GET/POST /api/admin/roster`, `POST /api/admin/roster/:id/invite` | mod | Pre-creates a stock + a 30-day claim code | `POST /exchanges/{id}/invites` (exchange invites; IPO is separate) | replace |
| `POST /api/admin/roster/:id/delist` | mod | Force-delist | Admin action, console only | keep for the console |
| `POST /api/admin/users/:id/reset-code` | mod | Issues a password reset code | Not needed | keep for the console |
| `GET/POST /api/admin/glossary` | mod | Lore glossary fed to the judge | Per-exchange lore (no `/v1` endpoint yet) | adapt (+ `exchange_id`) |
| `GET /api/admin/diagnostics/jobs`, `GET /api/admin/export` | mod / owner | Job queue view; full JSON export | Console only | keep for the console |
| `GET/POST /api/predictions`, `.../:id/bet`, `.../:id/resolve` | user / mod | Prediction markets | Not in the contract | keep on `/api`; open question |
| `GET /api/options`, `POST /api/options/quote`, `POST /api/options/buy` | user | Options | Phase 3 in the plan; not in the contract | keep on `/api`; open question |
| `GET /api/admin/chatgpt/*`, `GET /auth/callback` | mod | Runs the judge on an owner's personal ChatGPT login | Dropped per PLAN.md | drop |
| `/uploads/*` (static) | user | Serves avatars from local disk | Object storage + signed URLs (Phase 1) | replace |
| `/*` (static) | none | The built React console from `web/dist`, SPA fallback | Stays the admin console | keep |

### Tables

Migrations `001`–`011`, applied by `scripts/migrate.ts` and tracked in `schema_migrations`. Every game table is scoped to one global season today; none has an `exchange_id`.

| Table | Holds | Becomes | Verdict |
| --- | --- | --- | --- |
| `users` | username (citext, unique), argon2 hash, **global** role, lockout | Global identity. Add `email` (unique, citext) for code sign-in; the role moves to `memberships`; the password stays optional for the console | adapt |
| `person_stocks` | display name, ticker (**globally unique**), avatar, `owner_user_id` (**unique: 1 stock per user**), active/claimed/consented/opted-out, `seasonal_aura`, `career_aura` | `listings` (per exchange, ticker unique per exchange) + `memberships` (role, consent, opt-out). Aura columns become fair value `B`/`H`, volatility and last event time | replace (migrate the rows in 0.3) |
| `invites` | claim code (hashed) per pre-created stock, 30-day expiry | Exchange invites (code → join; the member then IPOs with their own ticker) | adapt |
| `sessions` | cookie session hash, CSRF token, 14-day expiry, UA/IP, revoked | Console only. `/v1` gets `refresh_tokens` (family, rotation, reuse = revoke) | keep for the console |
| `password_reset_tokens` | admin-issued reset codes | Console only. `/v1` gets `login_codes` | keep for the console |
| `seasons` | number, status, start/end; **one ACTIVE season globally** (unique index) | Per exchange: `exchange_id`, and the unique index becomes `(exchange_id) WHERE ACTIVE` | adapt |
| `aura_submissions` | the event: author, subject, text, content hash, status (`PENDING … FAILED`, `FARMING`, `DECLINED`) | `events`: add `exchange_id`, rumor end, teaser, statement, self-filed flag, `SENDING`/`RUMOR`/`RULING`/`RULED`/`HALTED`/`REVIEW`/`VOIDED`/`CANCELED`/`HIDDEN` | adapt |
| `aura_rulings` | verdict, delta (−30…30), confidence, rationale (≤280), category (free text), policy flags, provider/model, review flags, `is_current` | `rulings`: add headline (≤90), analyst note (≤280), fixed category enum, final impact | adapt |
| `aura_ledger_entries` | the immutable aura score ledger (rulings, votes, **trades**, farming rewards) | Replaced by the price engine (`listings.B/H` + `drift_queue`). Keep it read-only as history | replace |
| `aura_votes` | up/down per (feed event, voter) | Votes keyed by event id (+ `exchange_id`) | adapt |
| `aura_swing_polls`, `aura_swing_votes` | "Aura Farming" polls (1 h, plurality, ties → RECONSIDER) | `halts` (+ halt votes); poll length becomes 30 min | adapt |
| `appeals` | subject appeal, PENDING / UPHELD / OVERTURNED | Same + `exchange_id` | keep |
| `market_pools` | AMM reserves per (season, stock), opening and day-open price, `halted_until`, `organic_price`, `ambient_deviation` | Same + `exchange_id`; drop `organic_price`/`ambient_deviation` (PLAN.md); halts move to the `halts` table | adapt |
| `market_price_ticks` | price per tick, cause `OPEN`/`TRADE`/`AMBIENT`, synthetic flag | The engine tick's output (causes gain NEWS/DRIFT/NOISE/REVERSION); rolled into `candles_1m`/`candles_1h` in Phase 1 | adapt |
| `positions` | long or short qty (never both), averages, short proceeds and collateral, realized P&L | Same + `exchange_id`; `ShortDetail`/liquidation price computed on read | keep |
| `trade_quotes` | 15 s quote with `reserve_version` | Same + `exchange_id` + `previous_quote_id` | keep |
| `trades` | immutable fills (trigger-protected), unique `(user, idempotency_key)` | Same + `exchange_id` | keep |
| `ledger_transactions`, `cash_ledger_entries` | the double-entry cash ledger (entries immutable by trigger). Account keys are strings like `USER:{user}:CASH:{season}` | Keep. A season already belongs to one exchange, so the account keys stay unique without changing their format | keep |
| `limit_orders` | buy/sell limits, reserved cash, OPEN / FILLED / CANCELED / EXPIRED / DELISTED / SEASON_CLOSED | `orders`: add stop-loss/take-profit, trigger price, map to the contract's order statuses | adapt |
| `dividend_settlements` | weekly per-share dividend from net positive aura | Same + `exchange_id`; based on final event impact, not the aura ledger | adapt |
| `index_snapshots` | Aura Composite + market index every 5 min | Exchange index candles (Phase 1) | adapt |
| `feed_events` | the tape: `kind` + JSON payload, `actor_id`, hidden flag | `/v1` tape items (typed, privacy-filtered) + `exchange_id` | adapt |
| `notifications` | user, kind, JSON payload, `read_at` | `/v1` `Notification` (typed kinds, title/body, listing ref) + prefs | adapt |
| `season_results` | final standings snapshot per season | Same (exchange comes via the season) | keep |
| `prediction_markets`, `prediction_bets` | prediction markets | Not in the contract | keep (`/api` only); open question |
| `option_quotes`, `aura_options` | options | Phase 3 | keep (`/api` only); open question |
| `glossary_entries` | lore phrases for the judge, phrase **globally unique** | Per exchange | adapt |
| `moderation_actions`, `audit_logs` | moderator decisions; audit trail | Same + `exchange_id` where it applies | keep |
| `jobs`, `scheduled_runs`, `system_state` | job queue (SKIP LOCKED, 3 attempts with backoff), run-once keys for schedulers, worker heartbeat and restore-test state | Keep. Scheduler keys gain the exchange id | keep |
| `chatgpt_connections`, `chatgpt_oauth_attempts` | stored ChatGPT OAuth credentials | Dropped per PLAN.md | drop |
| `schema_migrations` | applied migration filenames | Keep | keep |

### Jobs (the worker)

`src/worker.ts` runs one loop: heartbeat → schedulers → claim one job → sleep `WORKER_POLL_MS` (2 s). Schedulers are deduplicated through `scheduled_runs` keys, so restarts and two workers don't double-run, but they aren't leader-locked. All the times use one global `TZ` (America/New_York).

| Job / scheduler | Cadence | What it does | Becomes | Verdict |
| --- | --- | --- | --- | --- |
| `JUDGE_AURA` job | per filing | Calls the judge. Hard flag, REVIEW or confidence < 0.75 → `REVIEW`; \|delta\| > 15 → Aura Farming poll; otherwise applies the aura entry, a feed item and a notification. Failures retry twice, then fall back to REVIEW | The Analyst step of the event pipeline (teaser, headline, note, category); applies a price shock instead of aura | adapt |
| `applyAmbientMarketMotion` | 15 s | Random walk clamped to ±3% of `organic_price`, re-solving reserves at the same `k` | The engine tick (mean reversion + drift + Student-t noise), advisory-locked, one transaction per exchange | replace (the reserve re-solve carries over) |
| `processOpenLimitOrders` | 15 s | Fills up to 50 open limits whose execution price crosses the limit | Same + stop-loss/take-profit, checked every tick | adapt |
| `snapshotIndices` | 5 min | Writes `index_snapshots` | Index candles per exchange | adapt |
| `liquidateUnsafeShorts` | 1 min | Shorts under 125% get bought back, up to 10% of the pool per run; any shortfall is absorbed by issuance; feed item + notification | Every tick; 140% warning notification; the liquidation tape item must not name the trader | adapt |
| `resolveExpiredAuraFarming` | 1 min | Closes polls. Every voter gets A$100 **and +2 aura** | Halt-vote resolution (A$100, no aura) | adapt |
| `settleExpiredOptions` | 1 min | Cash-settles expired options from issuance | `/api` only | keep (`/api` only) |
| `closeExpiredSeason` | hourly check | Releases limits, settles derivatives, snapshots standings, settles all positions at the last price, opens the next season: new pools at the default reserves, aura reset to 100, A$10,000 grant | Per exchange; prices reset to 100 (open question 4) | adapt |
| `grantAllowance` | Mondays ≥ 9 am | A$1,000 to every active member | Per exchange, in its timezone | adapt |
| `settleDividends` | Mondays ≥ 9 am | 0.25 per share per point of net positive aura in the last 7 days (shorts pay) | Per exchange; based on final event impact | adapt |
| `chargeBorrowFees` | daily | 0.1% of short value per day, from escrow | Per exchange; the Fed sets the base rate; hard-to-borrow ramp | adapt |
| `market-open` | daily (first loop after midnight) | Resets `day_open_price` and clears every `halted_until` | Market hours per exchange (PRE/OPEN/AFTER/CLOSED) | replace |
| stale-job recovery | on start | Resets jobs stuck `RUNNING` > 5 min | Keep | keep |

### Other code

| Piece | Verdict | Notes |
| --- | --- | --- |
| `src/core/market.ts` (`quoteTrade`, `spotPrice`, `reserveVersion`, collateral, `isLiquidatable`) | keep | Constant product, 0.5% fee as a parameter, 10%-of-pool order cap, 40-digit `Decimal`, half-up rounding. `marketAuraAdjustment` (trade → aura) is dropped, and so are `auraComposite`/`marketIndex` in their current form. |
| `src/core/ledger.ts` | keep | `normalizeBalancedPostings` is pure and tested. |
| `src/core/aura-voting.ts` | adapt | Becomes vote → impact adjustment with the ±50% cap. |
| `src/core/price-history.ts` | replace | Replays trades from hard-coded 1,000/100,000 reserves. Candles come from ticks instead. |
| `src/core/derivatives.ts` | keep (`/api` only) | |
| `src/ai/judge.ts` | adapt | Provider-neutral, JSON-schema output, `fake` provider. Drop `ChatGPTPlanAuraJudge`. Extend the output with headline, note, category enum and teaser. |
| `src/services/chatgpt-plan-service.ts` | drop | |
| `src/services/feed-service.ts` (`serializeFeedEvent`) | adapt | The author-hiding rule carries over into the `/v1` serializers. |
| `src/services/portfolio-service.ts` | keep | `equity = cash + long value + short escrow − short liability`. |
| `src/errors.ts` (`AppError(statusCode, message, code, details)`) | adapt | Becomes the contract `AppError` in 0.2 (see Plumbing). |
| `src/auth.ts` | keep for `/api` | Bearer auth for `/v1` is new (0.4). |
| `scripts/seed.ts`, `scripts/mock-api.ts`, `scripts/pilot-reset.ts` | keep | `mock-api.ts` mocks the old `/api` for the web preview. Prism mocks `/v1`. |
| `scripts/*.ps1`, `Caddyfile`, `compose.yaml` | keep for now | Home-PC hosting. Replaced by cloud deploy in 0.7; `compose.yaml`'s `postgres` service is useful for local dev. |
| `tests/` (8 files, 23 tests) | keep | Pure unit tests, no DB. `candles.test.ts` imports from `web/src/`. |

### Where the code and the plan disagree

These matter when `/v1` and the engine replace the old behaviour. Where `DECISIONS.md` or `PLAN.md` gives a number, the plan wins. None of these are changed in Phase 0 for `/api`.

| Thing | Code today | Plan / decisions |
| --- | --- | --- |
| Pool at IPO | 1,000 shares / A$100,000 (DB defaults and `replayPriceHistory`) | 4,000 shares / A$400,000 |
| Trades move aura | Yes: a buy adds up to +10 aura (`marketAuraAdjustment`), which feeds dividends | No; events move fair value, and trades only move price |
| Rulings move price | No, only `seasonal_aura` (dividends) | Yes, through m(d), the gap and the drift |
| Filing about yourself | Forbidden | Allowed; gains count at half impact |
| Up/down votes | ±10% of \|delta\| each, uncapped, no expiry | ±10% each, capped at ±50%, 2-hour window, `conflicted` flag |
| Big-ruling vote | 1 hour, plurality (ties → RECONSIDER), voters get A$100 + 2 aura | 30 minutes, A$100 |
| Single-stock halt | A 35% move from the day open halts for 30 min | A 10% move in 5 minutes halts for 5 min; also news halts and the market-wide breaker |
| Market hours | Always open; one global timezone | PRE / OPEN / AFTER / CLOSED per exchange, 1.5% fee in extended hours |
| Liquidation | Every minute, up to 10% of the pool per run | Every tick, at 125%; warning at 140% |
| Borrow fee | Flat 0.1% a day | 0.1–1% a day (hard to borrow above 20% short interest; the Fed sets the base) |
| Daily filing limit error | `400 RATE_LIMITED` | `422 DAILY_FILING_LIMIT` |
| Roles | Global OWNER / MODERATOR / MEMBER | Per exchange (`Role` in the spec) |

### Gaps to handle in `/v1`

- **Privacy.**
  - `TRADE` feed items carry the trader in `actor_id`, and `serializeFeedEvent` shows their name to everyone.
  - `LIQUIDATION` items do the same, which breaks "liquidation headlines never name the person liquidated."
  - `/v1` tape serializers must only emit anonymous `WHALE` and `LIQUIDATION` items.
  - `/api/stocks/:id/history` also names traders in its replayed points; that stays a console-only route.
- **Error codes with no contract code yet.**
  - The code raises `INSUFFICIENT_SHARES` and `SHARES_RESERVED` (selling more than you hold or have free), `INVALID_COVER`, `QUOTE_USED`, `QUOTE_EXPIRED`, `INSUFFICIENT_LIQUIDITY`, `INVALID_QUANTITY`, `DUPLICATE_TICKER`, and a generic `FORBIDDEN` (role checks).
  - `Error.code` in the spec is an open string; the `ErrorCode` enum only documents the known codes, so new codes are additive. Plan for 0.2/0.5:
    - map `QUOTE_EXPIRED`/`QUOTE_USED` to `QUOTE_STALE`;
    - map ticker-taken to the `TickerCheck` response (not an error);
    - map quantity checks to `VALIDATION`;
    - add `INSUFFICIENT_SHARES` and `FORBIDDEN` to the spec as additive codes, logged in `openapi/CHANGES.md`.
- **Origin check.** The `preHandler` 403s any write whose `Origin` doesn't match `APP_ORIGIN`. The native app sends no `Origin`, so it's fine, but the Flutter web preview would. `/v1` should skip this check, since it's a CSRF guard and bearer auth isn't CSRF-prone.
- **Rate limit.** There's one global 200/min per IP. `/v1` needs a typed `429 RATE_LIMITED` with `retryAfterSeconds`.
- **`market-open` clears every `halted_until`**, including the `'infinity'` that marks a delisted pool. That's harmless today because quotes also check `is_active`, but the halts table replaces it anyway.

## Plan for 0.2–0.4

Written at the end of 0.1. Each bullet is about one commit.

### 0.2 Error shape, version gate, idempotency, health, contract tests

1. **App factory.** Move `src/server.ts` into `src/app.ts` → `buildApp()`, so tests can `app.inject()` without listening. `server.ts` just migrates-checks and listens. No behaviour change for `/api`.
2. **Contract errors.**
   - Rework `AppError` in `src/errors.ts` to carry `code`, `httpStatus`, `params` (strings), `action` and `retryable`, with a per-code defaults table copied from `API-CONTRACT.md`. Keep `badRequest`/`forbidden`/… as thin wrappers so `/api` throw sites don't change.
   - One `setErrorHandler`:
     - `/v1/*` gets `{ error: { code, message, params, retryable, action } }`;
     - `/api/*` keeps `{ error, message, details }`.
   - Zod errors become `VALIDATION {field, rule}`; rate-limit errors become `RATE_LIMITED {retryAfterSeconds}`; unknown errors become `SERVER {reference: requestId}`; unmatched `/v1` routes become `NOT_FOUND`.
3. **Version gate.**
   - An `onRequest` hook on `/v1`: `X-App-Build` below `MIN_APP_BUILD` (env, default 1) → `426 UPDATE_REQUIRED {minBuild}`.
   - A missing header is allowed (web console, curl, tests).
4. **Idempotency.**
   - Migration `012_idempotency_keys.sql`: `(scope, key)` primary key, where scope is the user id, or `anon` before sign-in. Also stores method + route, a body hash, status, response JSON and `expires_at` (24 h).
   - A preHandler on every `/v1` POST/PATCH/DELETE: the header is required (`400 VALIDATION {field: Idempotency-Key}`). A replay returns the stored response; the same key with a different body → `409 IDEMPOTENCY_MISMATCH`; the same key still in flight → `409 IDEMPOTENCY_IN_PROGRESS` (new additive code, retryable). Store 2xx/4xx responses, never 5xx.
   - The worker purges expired rows. `trades (user, idempotency_key)` stays as the second guard.
5. **`GET /v1/health`.**
   - Returns `status`, `serverTime`, `minBuild` and `lastGoodUpdate` (the last worker heartbeat).
   - `DEGRADED` when the heartbeat is older than 30 s. `MAINTENANCE` comes from `MAINTENANCE_UNTIL` (env) and makes every other `/v1` route `503 MAINTENANCE`.
6. **Contract-test harness.**
   - Add `ajv` (2020-12), `ajv-formats` and `yaml`.
   - `tests/contract/` loads `openapi/v1.yaml` and validates every response by operation + status.
   - DB-backed tests use a `aura_test` database in a dev Postgres. A new `compose.dev.yaml` runs only `postgres:18` on `127.0.0.1:5432`, matching `config.ts`'s default `DATABASE_URL`, because `compose.yaml`'s postgres has no host port.
   - `pnpm check` then needs that container running; NOTES.md will say so.
   - **Check:** `/health`, `426 UPDATE_REQUIRED`, `400 VALIDATION` and `409 IDEMPOTENCY_MISMATCH` validate against the spec.

### 0.3 Multi-tenancy

1. **Migration `013_exchanges.sql`.**
   - `exchanges`: name, IANA timezone, `pre_open`/`open`/`close`/`after_close` local times, fee and extended fee rates, `min_listings_to_open` (default 3), a settings JSON (quiet decay, borrow rate, allowance), created by and at.
   - `memberships`: `(exchange_id, user_id)` unique, role `MEMBER`/`MODERATOR`/`ADMIN`, `joined_at`, `listing_consent_at`, `opted_out_at`.
   - `person_stocks` becomes `listings`, with `exchange_id` and `membership_id`. A compatibility view named `person_stocks` keeps the old `/api` SQL working until `/api` is retired. (If the view fights `FOR UPDATE`/`ON CONFLICT` anywhere, fall back to keeping the table name and recording why.)
2. **`exchange_id` on every game table**, backfilled to one "Default" exchange (the current `TZ`, default hours). Today's users become members; OWNER becomes ADMIN.
   - Game tables: seasons, pools, positions, quotes, trades, orders, events, rulings, votes, polls, appeals, feed, notifications, glossary, dividends, index snapshots, invites, predictions, options, moderation and audit.
   - Uniques become per exchange: the one active season, ticker, one listing per member, glossary phrase.
   - Existing tickers with digits don't match the spec's `^\$[A-Z]{3,5}$`. The migration leaves them as they are, and the `/v1` serializers will flag any.
3. **Scoping.**
   - Every service takes an `exchangeId`; `/api` routes pin to the Default exchange; the worker loops over exchanges.
   - A `requireMembership` guard: exchange routes → `403 NOT_A_MEMBER {exchangeId}`; resources (listing, order, event) from another exchange → `404 NOT_FOUND`, so nothing leaks that they exist.
4. **`minListingsToOpen`.** `tradingEnabled = listedCount ≥ minListingsToOpen`, and quotes/trades are refused below it.
5. **Check:** a DB test with two exchanges (members, listings, trades, feed) proves every scoped query and route returns only its own exchange's data.

### 0.4 Token auth

1. **Migration `014_token_auth.sql`.**
   - `users.email` (citext, unique, nullable for console-only users) and `users.display_name`. `password_hash` becomes nullable.
   - `login_codes`: HMAC-SHA256 of the 6-digit code, 10-minute expiry, 5 attempts, consumed flag.
   - `refresh_tokens`: hash, `family_id`, parent, `used_at`, `revoked_at`, 30-day expiry.
2. **`POST /auth/email/start`.**
   - Always `204`, so it never reveals whether an email exists.
   - Rate-limited per email and per IP → `429 RATE_LIMITED`. A new code supersedes older ones.
   - An `EmailSender` interface; the dev implementation logs the code. The provider is open question 8.
3. **`POST /auth/email/verify`** finds or creates the user, then returns a `jose` HS256 access token (15 min, `JWT_SECRET` env, required in production) and a refresh token.
   - SCREENS.md needs "wrong code" and "code expired" as separate states, and the contract has no codes for them. Add `LOGIN_CODE_INVALID {attemptsLeft}` and `LOGIN_CODE_EXPIRED` as additive codes, logged in `openapi/CHANGES.md`, and tell Nathan so the app syncs.
4. **`POST /auth/refresh`** rotates the pair; reusing a used token revokes the whole family → `401 AUTH_EXPIRED`. **`POST /auth/logout`** revokes the family → `204`.
5. **Bearer guard** on `/v1` (except `/health` and `/auth/*`). An expired or invalid token → `401 AUTH_EXPIRED`. Cookies and CSRF stay on `/api`.
6. **`GET /me`**: the user plus their memberships.
7. **Check:** contract tests for all five auth operations and `/me`, plus a test that reusing a refresh token revokes the family.

## Plumbing choices

Plumbing decisions that are mine to make. Game rules go to `DECISIONS.md` instead.

- 2026-10-24: `/v1` lives under `src/v1/` as a Fastify plugin with the prefix `/v1`. The old `/api` routes are untouched.
- 2026-10-24: one error handler for both surfaces. Requests under `/v1` get the contract shape `{ error: { code, message, params, retryable, action } }`; `/api` keeps its current `{ error, message, details }` body so the web console keeps working.
- 2026-10-24: `AppError(code, statusCode, params, action, retryable, message, details)`. `appError(code, params)` fills status, action and retryable from the contract table in `src/errors.ts`; the legacy helpers (`badRequest`, …) still work. On `/v1`, `toContractError` translates anything thrown: legacy codes (e.g. `INSUFFICIENT_FUNDS` → `INSUFFICIENT_CASH`), Zod errors (`VALIDATION {field, rule}`), Fastify 4xx, the rate limiter (`RATE_LIMITED {retryAfterSeconds}`) and unknown errors (`SERVER {reference: requestId}`, details only in the log).
- 2026-10-24: **fixed an existing `/api` bug.** `server.ts` called `setErrorHandler` after registering the routes, and Fastify binds the handler at registration, so the custom handler never ran for `/api`. Invalid input returned `500` with the raw Zod issues as the message. The handler now comes first: invalid input → `400 VALIDATION_ERROR`, `AppError`s → `{ error, message, details }`, Fastify's own 4xx pass through. The web console only reads `message`, which every shape has. Worth telling the friend: it's on his `master` too.
- 2026-10-24: three additive error codes in the spec (`1.0.0-draft.2`): `FORBIDDEN`, `CONFLICT`, `IDEMPOTENCY_IN_PROGRESS`.
- 2026-10-24: version gate. A missing `X-App-Build` is allowed (the web console, curl, Prism); a non-integer → `400 VALIDATION {field: X-App-Build}`; below `MIN_APP_BUILD` → `426`. It applies to every `/v1` route, `/health` included (the spec lists 426 there).
- 2026-10-24: maintenance. `MAINTENANCE_UNTIL` (env) in the future makes every `/v1` route except `/health` answer `503 MAINTENANCE {until, reference}`; `/health` stays `200` with `status: MAINTENANCE`. `/health` is `DEGRADED` when the worker heartbeat is missing or older than 30 s, and `lastGoodUpdate` is that heartbeat.
- 2026-10-24: timestamps go out through `isoTime()` (`src/v1/serialize.ts`): UTC, whole seconds, `Z`.
- 2026-10-24: contract tests. `tests/contract/openapi.ts` loads `openapi/v1.yaml` into ajv (2020-12 + formats) and validates a body by operation + status (`expectResponseMatchesSpec`) or by component schema (`expectSchema`). An undeclared status fails the test. A test keeps `errorCodes` in `src/errors.ts` equal to the spec's `ErrorCode` enum.
- 2026-10-24: `applyMigrations(pool)` moved into `migration-service.ts`; `scripts/migrate.ts` and the test setup both use it.
- 2026-10-24: idempotency (`idempotency_keys`, `src/v1/idempotency.ts`, `src/services/idempotency-service.ts`).
  - Keys are scoped per user (`anon` until 0.4) for 24 h. The request hash is `sha256(method, path + query, canonical JSON body)`, so key order in the body doesn't matter.
  - The preHandler claims the key with an insert. A taken key with another hash → `IDEMPOTENCY_MISMATCH`; still running → `IDEMPOTENCY_IN_PROGRESS` (retryable); done → the stored status and body are replayed byte for byte, with an `Idempotent-Replayed: true` header.
  - `onSend` stores 2xx/4xx and releases the key on 5xx. A claim older than 5 minutes with no response is presumed dead and released.
  - Known gap: a crash after a handler commits but before `onSend` stores leaves a claimed key with no response, so the retry runs again after 5 minutes. Trades keep their own `(user, idempotency_key)` unique guard against that; other money-moving writes should do the same when they arrive.
  - The worker purges expired keys hourly.
- 2026-10-24: spec `1.0.0-draft.3` declares the error responses every operation can already return (429 and 503 everywhere; 400 and 409 on every write). The contract tests are strict about undeclared statuses, so the spec had to say so.
- 2026-10-24: the error handler lives in `src/error-handler.ts`, so tests can mount `/v1` pieces on a small Fastify app.
- 2026-10-24: **multi-tenancy (migration 013).**
  - `exchanges` (hours as local `time`s, fee rates as fractions, `min_listings_to_open`, `settings` JSON) and `memberships` (`MEMBER`/`MODERATOR`/`ADMIN`, unique per user per exchange).
  - `person_stocks` is renamed to `listings`, and every SQL string was updated. No compatibility view; `stock_id` columns keep their name and point at `listings`. I dropped the planned `listings.membership_id`: `(exchange_id, owner_user_id)` is unique and identifies the membership.
  - Everything from before is the "Default" exchange (`is_legacy = true`, timezone `America/New_York`); every existing user became a member, with OWNER → ADMIN.
- 2026-10-24: `exchange_id` is on every game table: `NOT NULL` with an FK, except on `notifications` and `audit_logs`, where it's nullable for account-level rows.
  - It was added with the legacy id as a one-off default, so no rows were rewritten and the immutable-row triggers didn't fire.
  - A generic `enforce_exchange_id(parent, column, …)` trigger fills a missing `exchange_id` from the parent row (season, listing, submission, poll, feed item, prediction) and rejects any row whose parents disagree with it or each other (`check_violation`). New `/v1` code should still pass `exchange_id` explicitly; the trigger is the backstop.
  - The cash ledger has no `exchange_id`: every account key ends in a season id, and a season belongs to one exchange.
- 2026-10-24: uniques that were global are now per exchange: the one active season, season number, ticker, owner's listing, glossary phrase. `users.username` stays global (console sign-in).
- 2026-10-24: **the legacy `/api` serves only the Default exchange.**
  - `loadSession` puts `exchangeId` on `request.auth`, and every `/api` query is filtered by it, including lookups by id, so the console can't reach another exchange's stock, quote, order, poll, prediction or user.
  - Joins from a user to "their" listing also match the exchange, otherwise someone listed on two exchanges would duplicate rows.
  - First-run setup is "needed" while the Default exchange has no members (it used to be "while `users` is empty").
  - `/api/admin/diagnostics/jobs` and `/api/health` stay server-wide: they're the operator's views.
- 2026-10-24: `notifyUser(client, exchangeId | null, userId, kind, payload)`. `notifyStockOwner` takes the exchange from the listing.
- 2026-10-24: `minListingsToOpen` is stored per exchange, and `tradingState()` (`src/services/exchange-service.ts`) computes `tradingEnabled`. It will gate `/v1` quotes and trades in 0.5. The legacy `/api` isn't gated, so the friend's console behaves as before; the 3-listing rule is still awaiting Nathan's OK (DECISIONS.md).
- 2026-10-24: **the worker is per exchange.**
  - The jobs moved to `src/jobs/schedulers.ts` (exported and tested); `worker.ts` is just the loop.
  - `runServerSchedulers` runs the row-by-row jobs that never mix exchanges in one transaction: limit fills, liquidations, halt-vote resolution, option settlement, and the idempotency and `scheduled_runs` purges.
  - `runExchangeSchedulers(exchange)` runs everything else on the exchange's own timezone, with run-once keys like `allowance:<exchangeId>:<date>`: ambient motion (one transaction per exchange), index snapshots, season close, allowance, dividends, borrow fees, market open.
  - Migration 014 copies the already-completed keys into that form, so a mid-Monday deploy can't pay the allowance or dividends twice.
  - A failing job is logged and retried on the next loop. It no longer takes down the worker or another exchange's schedule (an exception used to exit the process).
- 2026-10-24: **the `/v1` membership guard** (`src/v1/membership.ts`).
  - `membershipGuard({ roles? })` is the preHandler for `/exchanges/{exchangeId}/…`. Unknown, malformed or foreign exchange ids all answer `403 NOT_A_MEMBER {exchangeId}`; a role mismatch answers `403 FORBIDDEN`.
  - `requireScopedResource(db, request, table, id)` is for id-addressed routes (listing, position, order, event, halt, quote). Another exchange's resource answers the same `404 NOT_FOUND {resource}` as a missing one.
  - Both read `request.v1User`, which only the bearer guard (0.4) sets, never the console cookie. Idempotency keys are now scoped by `request.v1User.id` (`anon` before sign-in).
- 2026-10-24: **token auth (0.4).**
  - Sign-in codes: 6 digits, stored as an HMAC (keyed from `AUTH_SECRET`) with 10 minutes to live and 5 tries. A new code supersedes the old one.
  - Limits: 5 codes per email per hour (`429 RATE_LIMITED {retryAfterSeconds}`) and 20 per IP per hour (the route-level rate limiter, configurable). `start` always answers 204, so it never says whether an account exists.
  - `verify` creates the account on first sign-in, with the email's local part as the display name. A wrong code is `401 LOGIN_CODE_INVALID {attemptsLeft}`; an expired, superseded or exhausted code is `401 LOGIN_CODE_EXPIRED`. The app needs a new `Idempotency-Key` for each code it submits.
  - Access tokens: HS256 JWT from `jose`, 15 minutes, `iss=aura-exchange`, `aud=aura-app`, `typ=access`, key derived from `AUTH_SECRET`. They can't be revoked before they expire, so logout leaves at most 15 minutes.
  - Refresh tokens: opaque `rt_…`, stored as sha256, 30 days, rotated on every use within a family. Reusing a used token revokes the whole family; logout revokes the family.
  - Email goes through `EmailSender`. The default logs the code, which is fine in development; production needs a provider (open question 8).
- 2026-10-24: **bearer auth on `/v1`** (`src/v1/bearer.ts`).
  - It's required on every route not marked `config: { public: true }`; the public ones are `/health`, `/auth/email/start`, `/verify` and `/refresh`. A missing, bad or expired token is `401 AUTH_EXPIRED`. On public routes a bad token is ignored, so a refresh still works when the app attaches its stale token.
  - Idempotency on public routes always uses the `anon` scope, so a retried refresh replays even if the access token expired between tries.
  - `/v1` skips the cookie session lookup and the console's Origin/CSRF check.
- 2026-10-24: `GET /me` returns `avatarUrl: null` until avatars move to object storage (Phase 1), `badges: []` and `superInjunctionsLeft: 3` (Phase 2 features).
- Known gaps from 0.4:
  - Console users (username + password) have no email, so they can't sign in to the app until one is linked. That needs a way to add an email from the console, or to claim an existing listing by email. It can come with invites in 0.5.
  - A legacy ticker with digits wouldn't match the spec's `^\$[A-Z]{3,5}$`.
- 2026-10-24: **0.5 market hours.**
  - Sessions are computed per exchange in its timezone (`src/core/market-hours.ts`). Every day is a trading day (open question 3).
  - Phase 0 only has market orders, so `/v1` quotes and trades need the regular session: CLOSED → `MARKET_CLOSED {opensAt, queuedEvents: "0"}`, PRE/AFTER → `ORDER_TYPE_NOT_ALLOWED {marketState}`. Limit orders for extended hours come with `/orders` in Phase 1.
  - Boundaries are found by walking forward from now, so they can be an hour off on the two days a year the clocks change.
  - `V1Options.now` lets tests pin the clock.
- 2026-10-24: **0.5 trading.**
  - New `/v1` IPOs get the plan's 4,000-share, A$400,000 pool; legacy pools stay at 1,000 / A$100,000.
  - The money movement (`executeTrade`, `src/services/trade-execution.ts`) is shared with the console's execute route. Only the console still moves aura on a trade; `/v1` trades don't (PLAN.md drops trade-to-aura coupling).
  - `/v1` has its own order rules (`checkOrder`, `src/services/order-checks.ts`), the same rules as the console's `validateOrder` but answering contract errors. That's two copies of one rulebook until `/api` is retired, so keep them in step.
  - Every reducible rejection carries `maxQuantity`, the largest 0.0001-step quantity the same rules accept (binary search).
  - `/trades` uses the `Idempotency-Key` header as the trade's `idempotency_key`, the second guard behind the idempotency layer.
- 2026-10-24: **0.5 market data.**
  - `prevClose` is the pool's `day_open_price`, which the daily market-open job resets. The sparkline and day high/low cover the last 24 hours (48 half-hour points); candles are UTC buckets.
  - Badges: `HARD_TO_BORROW` above 20% short interest and `OTC_PINK` under 5.00.
  - A halted pool shows `state: HALTED`, but `halt` is `null` and `LISTING_HALTED.haltId` is `""` until Phase 1's halts table.
  - Events, markers, the indicated price and analyst notes are empty until Phase 1.
- 2026-10-24: **0.5 invites.**
  - Codes are multi-use for 7 days, 8 characters with no 0/O/1/I. The URL is `INVITE_URL_BASE` (default `aura-exchange://invite/`) plus the code.
  - Exchanges are capped at 20 members (`settings.maxMembers`, open question 11).
  - The legacy claim route now ignores exchange invites.
- 2026-10-24: **0.5 portfolio.**
  - Net worth includes cash reserved by resting buy orders.
  - Season change is measured against what the season gave the member (`SEASON_GRANT` + `WEEKLY_ALLOWANCE`). Day change is Σ (long − short) × the move since the day's open.
  - `openedAt` is the first trade on that listing this season.
- 2026-10-24: **parity with the Prism mock.** For every success response, the contract harness also checks that every property the spec declares is present and nothing else is, recursively. The Prism mock serves exactly the declared properties, so real and mocked shapes can't drift. `tests/contract/coverage.test.ts` fails if any x-phase 0 operation lacks a validated success response.
- 2026-10-25: **named error examples** (spec draft.6, the app's contract request #1). Each shared error response lists one example per code at its status, keyed by the code. `tests/contract/system.test.ts` keeps them in step: every code in `errorCodes` has exactly one example, at its status, valid against `Error`, with its `action` and `retryable`, and with exactly the params API-CONTRACT.md's table lists. A new code therefore needs its row in the table and its example in the spec. Checked by hand against `@stoplight/prism-cli@5` in a container: `Prefer: code=409, example=QUOTE_STALE` serves that body.
- 2026-10-25: **the price engine** (`src/engine/`, pure, no I/O).
  - `rng.ts`: sfc32 seeded from a string hash, so the worker can seed each tick from something like `${listingId}:${tickAt}` and replay it exactly without storing RNG state. Normal (Box–Muller), Student-t scaled to unit variance (Marsaglia–Tsang gamma), exponential waits.
  - `news.ts`: m(d), its inverse, and `followOnMove(from, to)` for vote and appeal changes, so a changed impact moves price by m(new) relative to m(old), not by m(new − old).
  - `engine.ts`: `ListingState` holds the reserves and B as `Decimal` (they're prices); ln H, the volatility boost and the drift queue are numbers (dimensionless ratios). A ratio moves the pool through `moveReserves`, which divides shares and multiplies credits by the same √ratio, so the constant product holds exactly and there's no Decimal square root per tick (that was 85% of the tick's cost). Reserves are rounded to 8 dp.
  - Time: hype, the volatility spike and quiet decay run on wall-clock seconds; reversion, drift and noise run on open-market seconds. A trading day is PRE + OPEN + AFTER, 19 h with the default hours, so "2% daily vol" and the "2-trading-day half-life" are per 19 open hours. Reversion uses the exact discrete step, so one long tick and many short ones agree.
  - A news move F × (1 + m) is split in log terms: B × √(1+m) and H × √(1+m). The gap and the drift are fractions of the same log move. The volatility spike is 2 × |d|/30 on top of base (3× at ±30), with d read back from the combined move, so several queued rulings spike as one.
  - Quiet decay bleeds B (not H, which decays anyway), continuously at 0.5% a day after 3 quiet days, capped at 5% since the last ruling. `quietDecay: null` turns it off per exchange.
- 2026-10-24: **two more existing bugs fixed** (both on the friend's `master`):
  - The season-close standings query passed one parameter as `$1::text` and compared it with a uuid. Postgres rejects that (`uuid = text`), so seasons never closed and `pilot-reset` would time out.
  - The daily `market-open` cleared every `halted_until`, including the `'infinity'` that marks a delisted pool. It now leaves delisted pools alone.

## Checks

### How checks run (until Node 24 is on the host)

pnpm 11.25.0 (pinned in `package.json`) needs Node ≥ 22.13. The host only has Node 20.20.0 (nvm4w), and switching the global Node is Nathan's call. So `pnpm` runs in the Dockerfile's base image, with `node_modules` and the pnpm store in Docker volumes (the Linux native builds of argon2, sharp and esbuild never land in the OneDrive folder):

```powershell
docker run --rm -e CI=true -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 `
  -v "${PWD}:/app" -v aura_api_node_modules:/app/node_modules -v aura_pnpm_store:/pnpm-store `
  -w /app node:24-bookworm-slim `
  sh -c "corepack enable && pnpm config set store-dir /pnpm-store && pnpm install --frozen-lockfile && pnpm check"
```

The build writes `dist-api/` and `web/dist/` into the repo folder; both are gitignored.

Since 0.2 the wrapper is `scripts/pnpm-docker.ps1` (`powershell -File scripts/pnpm-docker.ps1 check`). The tests also need the dev database:

```powershell
docker compose -f compose.dev.yaml up -d    # postgres:18 on 127.0.0.1:5433 (a native PostgreSQL already holds 5432 on this PC)
```

`tests/global-setup.ts` drops and recreates `aura_test` (it refuses any name not ending in `_test`) and applies every migration, on every run. Inside the container the database is `host.docker.internal:5433`; on the host it's `localhost:5433`. Override with `TEST_DATABASE_URL`.

### Baseline, 2026-10-24 (0.1, untouched `aura-v1` = `49a0eaf` + docs)

- `pnpm install --frozen-lockfile`: OK. pnpm 11.25.0 on Node 24 (`node:24-bookworm-slim`); 184 packages; the lockfile is current and passes pnpm's supply-chain policy check.
- `pnpm check`: **passes**.
  - Typecheck: server and web, TypeScript 7.0.2.
  - Tests: vitest 5.0.5, 8 files, 23 tests, all green.
  - Build: `tsc` for the API, vite 8.3.5 for the web.
- No DB-backed tests exist yet; everything above is pure.
