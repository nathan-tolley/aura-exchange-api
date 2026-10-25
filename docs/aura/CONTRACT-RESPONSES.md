# Answers to the app's contract requests

The API session's answer to each request in the app repo's `docs/aura/CONTRACT-REQUESTS.md`. The API owns the contract, so these are decisions, not proposals. Each line in `openapi/CHANGES.md` points back here. Newest batch first.

Verdicts:

- **accepted**: in the spec now. "Served now" means the live server returns it; otherwise the field is in the spec (so Prism serves it) and the server fills it when its phase lands.
- **deferred**: agreed in principle, specified with the feature's own phase.
- **declined**: not doing it, with the reason and what to use instead.

## Request #10 (answered 2026-10-25, no spec change)

**#10, CORS for the web preview: accepted.** The server is ready, but the live box only gets it after a redeploy with Nathan's OK.

- `/v1` allows an exact list of origins from `CORS_ORIGINS` (comma-separated; empty means none, and never `*`). For the box, that's `CORS_ORIGINS=http://localhost:5555`.
- **Preflights** (`OPTIONS` with `Access-Control-Request-Method`) get `204` on any `/v1` path, before the version gate and the bearer guard, with:
  - `Access-Control-Allow-Origin` (the origin itself)
  - `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE`
  - `Access-Control-Allow-Headers: Authorization, Content-Type, Idempotency-Key, X-App-Version, X-App-Build`
  - `Access-Control-Max-Age: 600`
- **Every other `/v1` response**, errors included (401, 426, 429, 503…), gets these headers, so the app can read the error shape:
  - `Access-Control-Allow-Origin`
  - `Vary: Origin`
  - `Cross-Origin-Resource-Policy: cross-origin`
  - `Access-Control-Expose-Headers: Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Idempotent-Replayed`
- **No credentials.** `/v1` uses bearer tokens, never cookies, so `Access-Control-Allow-Credentials` isn't sent and the app mustn't set `withCredentials`.
- **Other origins** get none of these headers, so the browser blocks them.
- **`/v1/stream`** will check `Origin` against the same list when realtime lands (Phase 1). Native clients send no `Origin`, and they're always let through.

## Requests #2–#9 (answered 2026-10-25, spec `1.0.0-draft.7`)

| # | Ask | Verdict | What the contract says now |
| --- | --- | --- | --- |
| 2 | When the next stimulus check lands | **accepted**, served now | `nextStimulusAt` (ISO 8601 UTC) in `INSUFFICIENT_CASH`'s params **and** on `Portfolio`. |
| 3 | `changeAbs` on ticks | **accepted**, with `/stream` (Phase 1) | Each listing in a `ticks` message carries `changeAbs` next to `changePct`, both since the previous close, like `ListingSummary`. |
| 4 | A heartbeat in quiet market states | **accepted** (the heartbeat), with `/stream` (Phase 1) | Every subscribed exchange gets a `ticks` message at least every 30 s in every market state, CLOSED and HALTED included; `listings` is empty when nothing changed. `asOf` older than 60 s therefore always means something was missed. |
| 5 | ASCII example tokens | **accepted** | `TokenPair` examples are `eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJl` and `rt_9d8c4e2a`. |
| 6 | A refused quote that still shows its numbers | **accepted as option B** for `INSUFFICIENT_CASH` and `SHORT_CAP`, served now. **Option A declined**; priced params on `ORDER_TOO_LARGE` **declined** | Both codes add `price`, `gross`, `feeRate`, `fee`, `total` to their params: the same numbers, names and formats as `Quote`, for the quantity asked. |
| 7 | How a liquidation settled | **accepted with two changes**, filled in Phase 1 (margin) | `Position.liquidation`, `null` unless `status` is `LIQUIDATED`. |
| 8 | What Chapter 7 would do | **deferred** to Phase 2 (bankruptcy) | Planned: `Portfolio.bankruptcyOffer`, as asked. |
| 9a | `denialPenaltyPct` (W01) | **accepted**, with the event pipeline (Phase 1) | `Event.denialPenaltyPct`, always set (`"20.00"`). |
| 9b | `ratingChange` (W02) | **deferred** to Phase 2 (analyst ratings) | Planned: `UPGRADE` / `DOWNGRADE` / `REITERATE` beside `ListingDetail.analyst.rating`. |
| 9c | `superInjunctionsPerSeason` (W02) | **accepted**, served now | `Membership.superInjunctionsPerSeason` (`3`), beside `superInjunctionsLeft`. |
| 9d | An `SecCase` schema (W03) | **deferred** to Phase 2 (SEC) | Designed with the SEC feature. |

### Details

**#2.** "Next" is the next allowance the exchange's schedule will pay: Monday 09:00 in the exchange's timezone (PLAN.md → Economy). On a Monday before 09:00 that's today. The server works it out from the same constants the worker pays on, so the two can't drift. When the Fed can change the allowance (Phase 2), the schedule stays the same.

**#3 and #4.** The `ticks` message, as API-CONTRACT.md → Realtime now writes it:

```json
{ "type": "ticks", "exchangeId": "…", "asOf": "…", "marketState": "OPEN",
  "listings": [ { "id": "…", "price": "124.10", "changeAbs": "7.79", "changePct": "6.70", "state": "ACTIVE" } ] }
```

The heartbeat is the same message with `"listings": []`. The app can keep its single "older than 60 s → Delayed" rule in every state.

**#6.** Why B and not A:

- A would answer an existing x-phase 0 request with `201` where it answers `422` today. That changes behaviour rather than adding to it, and `/v1` only grows.
- A would also hand out quote ids that look tradable and aren't.
- B gives W05 everything from one answer: the receipt (`price`, `gross`, `fee`, `total`, `feeRate`) and the fix (`shortBy`, `maxQuantity`, `nextStimulusAt`).

`ORDER_TOO_LARGE` keeps only `maxQuantity`. The order is refused before it's priced, because the price of more than 10% of the pool isn't one anyone can trade at, and at the whole pool there's no price at all. Show the cap and offer `maxQuantity`.

The full params, in API-CONTRACT.md's table:

- `INSUFFICIENT_CASH`: `needed`, `available`, `shortBy`, `maxQuantity`, `nextStimulusAt`, `price`, `gross`, `feeRate`, `fee`, `total`
- `SHORT_CAP`: `maxQuantity`, `capPct`, `price`, `gross`, `feeRate`, `fee`, `total`

**#7.** `Position.liquidation`, an object or `null`:

| Field | Meaning |
| --- | --- |
| `at` | When it was bought back |
| `triggerPrice` | The price that crossed the liquidation price |
| `maintenanceRatioPct` | The ratio it fell under (`"125.00"`) |
| `collateral` | What was held against the short |
| `price` | Average buy-back price |
| `cost` | The buy-back before the fee |
| `feeRate` | Percent units, like `Quote.feeRate` |
| `fee` | |
| `returned` | What came back to your cash: `collateral − cost − fee`, never below zero (a shortfall is written off, not charged) |
| `realizedPnl` | The whole short's realized P&L, after fees |
| `realizedPnlPct` | Against the entry value (`avgPrice × quantity`) |

`Position.quantity` is the quantity bought back. The two changes from the ask:

- `feeRate`, not `feeRatePct`, because `Quote.feeRate` and `Exchange.feeRate` already name the same thing in the same units.
- `collateral` moves into the object, so the receipt adds up from one place. `Position.short` describes an open short, and it's `null` once the position is closed.

The `LIQUIDATED` notification will link to `GET /positions/{id}`.

**#8.** Bankruptcy is Phase 2 (`POST /exchanges/{id}/bankruptcy` is x-phase 2). The shape will be what you asked for: `minimumEquity`, `resetCash`, `badge`, `tapeHeadline` on `Portfolio`, set while `canDeclareBankruptcy`. The numbers are PLAN.md's (under A$100, reset to A$2,000, `CHAPTER_7`). Keep the fixture until then.

**#9a.** The rule is per exchange and doesn't change per event, but it sits on `Event` so W01 needs no second fetch. `Ruling.multipliers.denial` still shows what was actually applied (`"1.20"`).

**#9b.** Ratings are Phase 2. One question gets settled then with Nathan: PLAN.md makes ratings weekly, but W02 draws a rating change on a ruling. Can a ruling move the rating by itself?

**#9d.** The SEC case is Phase 2. Keep `SecCharge` as the stand-in; the schema will cover the fields you listed.
