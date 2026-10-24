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
  - The spec's `ErrorCode` enum is closed. Plan for 0.2/0.5:
    - map `QUOTE_EXPIRED`/`QUOTE_USED` to `QUOTE_STALE`;
    - map ticker-taken to the `TickerCheck` response (not an error);
    - map quantity checks to `VALIDATION`;
    - add `INSUFFICIENT_SHARES` and `FORBIDDEN` to the spec as additive codes, logged in `openapi/CHANGES.md`.
- **Origin check.** The `preHandler` 403s any write whose `Origin` doesn't match `APP_ORIGIN`. The native app sends no `Origin`, so it's fine, but the Flutter web preview would. `/v1` should skip this check, since it's a CSRF guard and bearer auth isn't CSRF-prone.
- **Rate limit.** There's one global 200/min per IP. `/v1` needs a typed `429 RATE_LIMITED` with `retryAfterSeconds`.
- **`market-open` clears every `halted_until`**, including the `'infinity'` that marks a delisted pool. That's harmless today because quotes also check `is_active`, but the halts table replaces it anyway.

## Plumbing choices

Plumbing decisions that are mine to make. Game rules go to `DECISIONS.md` instead.

- 2026-10-24: `/v1` lives under `src/v1/` as a Fastify plugin with the prefix `/v1`. The old `/api` routes are untouched.
- 2026-10-24: one error handler for both surfaces. Requests under `/v1` get the contract shape `{ error: { code, message, params, retryable, action } }`; `/api` keeps its current `{ error, message, details }` body so the web console keeps working.

## Checks

_Filled in by the last 0.1 step._
