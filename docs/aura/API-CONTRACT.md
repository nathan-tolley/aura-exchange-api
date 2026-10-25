# API contract: the boundary between the app and the server

`openapi.yaml` has the endpoints and schemas. This file has the rules that apply to all of them. Both projects follow it. A change to anything here is a contract change: it starts in the API repo, and then the copy in the app repo is synced.

## Transport

- Base URL: `https://<host>/v1`. All JSON is UTF-8, and field names are `camelCase`.
- **Auth**: `Authorization: Bearer <accessToken>`.
  - Access tokens last 15 minutes. Refresh tokens rotate: every `POST /auth/refresh` returns a new pair, and reusing an old refresh token revokes the whole family.
  - The app stores tokens in the iOS Keychain (`flutter_secure_storage`).
- **App version**: the app sends `X-App-Version: 1.2.0` and `X-App-Build: 37` on every request. If the build is below the server's `MIN_APP_BUILD`, the server answers `426` with error code `UPDATE_REQUIRED`.
- **Idempotency**: every `POST`, `PATCH` and `DELETE` carries `Idempotency-Key: <uuid v4>`.
  - Within 24 h, the server returns the stored response for a repeated key from the same user.
  - It returns `409 IDEMPOTENCY_MISMATCH` if the same key comes with a different body.
  - The app creates the key when the user commits the action (slides to confirm), not per network attempt, so retries are safe.
- **Pagination**: `?cursor=<opaque>&limit=<1..100, default 30>` → `{ "items": [...], "nextCursor": "..." | null }`.
- **Time**: every timestamp is ISO 8601 in UTC (`2026-10-24T13:21:00Z`).
  - Each exchange has an IANA `timezone`. The app shows times in the **exchange's** timezone, as relative time under an hour ("4 min ago").

## Numbers

- **Money and prices are decimal strings, never JSON numbers**: `"12486.20"`, `"124.10"`, `"-9935.88"`.
  - A$ amounts have exactly 2 decimals and prices exactly 2. Share quantities have up to 4 (`"20"`, `"12.5"`).
  - Percentages are decimal strings in percent units with 2 decimals: `"-12.19"` means −12.19%.
  - The server keeps 8 decimals internally (`decimal.js`, `numeric(20,8)`) and rounds half-up when serializing.
  - The app parses with a decimal type (the `decimal` package), never `double`, for anything that's money.
- Impact scores are integers from −30 to +30.

## Freshness: every market payload says how old it is

Any response with prices (market, listing, portfolio, quote, tick) includes:

```json
{ "asOf": "2026-10-24T01:41:00Z", "marketState": "CLOSED", "nextChangeAt": "2026-10-24T11:00:00Z" }
```

- `marketState` is one of `PRE`, `OPEN`, `AFTER`, `CLOSED`, `HALTED`. HALTED means the whole exchange is halted; a single halted listing has its own `listing.state = "HALTED"`.
- `nextChangeAt` is when `marketState` next changes (the open, the close, a halt ending).
- The app shows "Delayed · as of 9:41 pm" when the data is older than 60 s **or** the socket is down. It never shows old numbers as if they were live.

## One error shape

Every non-2xx response has this body:

```json
{
  "error": {
    "code": "INSUFFICIENT_CASH",
    "message": "You need A$229.91 more.",
    "params": { "needed": "2494.41", "available": "2264.50", "shortBy": "229.91", "maxQuantity": "18" },
    "retryable": false,
    "action": "REDUCE_QUANTITY"
  }
}
```

- `message` is English for logs and the web console. **The app never shows `message`.** It builds copy from `code` and `params` in one strings file (`lib/l10n/strings.dart`), so tone and wording are the app's job.
- `params` are always strings, formatted like the numbers above.
- `action` is one of `RETRY`, `REQUOTE`, `REDUCE_QUANTITY`, `SELL_SOMETHING`, `WAIT`, `SIGN_IN`, `UPDATE_APP`, `CONTACT_ADMIN`, `NONE`.

| HTTP | code | params | retryable | action | Designed screen |
| --- | --- | --- | --- | --- | --- |
| 400 | `VALIDATION` | `field`, `rule` | no | NONE | inline field error |
| 401 | `AUTH_EXPIRED` | | no | SIGN_IN | silent refresh, then sign-in |
| 401 | `LOGIN_CODE_INVALID` | `attemptsLeft` | no | NONE | sign-in: wrong code, try again (a new `Idempotency-Key` per attempt) |
| 401 | `LOGIN_CODE_EXPIRED` | | no | NONE | sign-in: code expired or out of tries; request a new one |
| 403 | `FORBIDDEN` | | no | NONE | generic "not allowed" (e.g. a moderator-only action) |
| 403 | `NOT_A_MEMBER` | `exchangeId` | no | NONE | |
| 403 | `SELF_TRADE` | `ticker` | no | NONE | trade button hidden on your own stock |
| 404 | `NOT_FOUND` | `resource` | no | NONE | |
| 409 | `CONFLICT` | | no | NONE | generic "that changed under you"; refetch |
| 409 | `QUOTE_STALE` | `oldPrice`, `newPrice`, `changePct` | yes | REQUOTE | W06 requote |
| 409 | `IDEMPOTENCY_MISMATCH` | | no | NONE | |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | | yes | RETRY | the first request with this key is still running; retry shortly with the same key |
| 409 | `INVITE_EXPIRED` | | no | NONE | S02 invite expired |
| 409 | `EXCHANGE_FULL` | `maxMembers` | no | NONE | S02 exchange full |
| 409 | `TICKER_TAKEN` | `ticker` | no | NONE | S03 ticker taken (check `/tickers/check` first) |
| 409 | `TRADING_NOT_OPEN` | `listedCount`, `minListingsToOpen` | no | WAIT | IPO day: trading opens once enough friends are listed |
| 409 | `LISTING_HALTED` | `haltId`, `resumesAt` | no | WAIT | W10 halted |
| 409 | `MARKET_CLOSED` | `opensAt`, `queuedEvents` | no | WAIT | W09 closed |
| 409 | `ORDER_TYPE_NOT_ALLOWED` | `marketState` (limit orders only in PRE/AFTER) | no | NONE | trade sheet |
| 422 | `INSUFFICIENT_CASH` | `needed`, `available`, `shortBy`, `maxQuantity` | no | REDUCE_QUANTITY | W05 rejected |
| 422 | `INSUFFICIENT_SHARES` | `available` | no | REDUCE_QUANTITY | selling or covering more than you hold |
| 422 | `ORDER_TOO_LARGE` | `maxQuantity` (10% of pool) | no | REDUCE_QUANTITY | W05 variant |
| 422 | `SHORT_CAP` | `maxQuantity`, `capPct` | no | REDUCE_QUANTITY | W05 variant |
| 422 | `OPPOSITE_POSITION` | `positionId` | no | NONE | "Close your short first" |
| 422 | `EQUITY_TOO_LOW` | `equity`, `minimum` | no | NONE | W04 Chapter 7 offer |
| 422 | `DAILY_FILING_LIMIT` | `limit`, `resetsAt` | no | WAIT | file sheet |
| 422 | `UNSEND_EXPIRED` | | no | NONE | |
| 426 | `UPDATE_REQUIRED` | `minBuild` | no | UPDATE_APP | W13 variant |
| 429 | `RATE_LIMITED` | `retryAfterSeconds` | yes | WAIT | toast |
| 500 | `SERVER` | `reference` | yes | RETRY | W13 exchange down |
| 503 | `MAINTENANCE` | `until`, `reference` | yes | RETRY | W13 exchange down |

New codes may be added (additive). The app maps unknown codes to a generic "Something went wrong · reference" screen.

## One status vocabulary

The same enums are used by REST, socket `status` messages and notifications. The app's StatusChip renders exactly these.

| Resource | Statuses |
| --- | --- |
| Event | `SENDING` (30 s, can unsend) → `RUMOR` (10 min) → `RULING` → `RULED` · or `HALTED` (group vote) · or `REVIEW` (moderators) · `VOIDED` · `CANCELED` (unsent) · `HIDDEN` (super-injunction: impact stays, story hidden) |
| Halt | `VOTING` → `CONFIRMED` · `DECLINED` · `RECONSIDERED` |
| Order | `SENDING` → `RESTING` → `FILLED` · `CANCELED` · `EXPIRED` · `REJECTED` |
| Position | `OPEN` · `CLOSED` · `LIQUIDATED` |
| SEC case | `REVIEWING` → `CLEARED` · `CHARGED` → `APPEALED` → `UPHELD` · `OVERTURNED` *(Phase 2)* |
| Listing | `ACTIVE` · `HALTED` · `DELISTED` |
| Market | `PRE` · `OPEN` · `AFTER` · `CLOSED` · `HALTED` |

## Realtime: `GET /v1/stream` (WebSocket)

- Connect with `?access_token=<token>`. The server closes with code `4401` when the token expires; the app refreshes and reconnects.
- The client sends `{ "type": "subscribe", "exchangeId": "…" }` (and `unsubscribe`), and `{ "type": "ping" }` every 25 s; the server answers `pong`.
- The server sends:

```json
{ "type": "ticks", "exchangeId": "…", "asOf": "…", "marketState": "OPEN",
  "listings": [ { "id": "…", "price": "124.10", "changePct": "6.70", "state": "ACTIVE" } ] }
{ "type": "tape", "exchangeId": "…", "item": { …TapeItem… } }
{ "type": "status", "resource": "event|halt|order|position|sec", "id": "…", "status": "RULED", "at": "…" }
{ "type": "notification", "item": { …Notification… } }
{ "type": "market", "exchangeId": "…", "marketState": "CLOSED", "nextChangeAt": "…" }
```

- Ticks are sent at most every 15 s per exchange, with only the listings that changed.
- **Fallback**: if the socket is down, the app polls `GET /exchanges/{id}/market` every 15 s while in the foreground and marks the data Delayed.
- The socket is an accelerator, never the source of truth. After a reconnect, the app refetches the screen it's on.

## Notifications (no push yet)

- The server writes a `Notification` row for every trigger in PLAN.md → Push notifications. These include: rumor about you, ruling about you, holding moved ≥5%, margin warning at 140%, liquidation, halt vote opened, order filled, SEC charge, and price alert.
- They are delivered live over the socket and listed at `GET /me/notifications`.
- When APNs arrives later, the same rows are pushed; nothing in the contract changes except `POST /devices` starting to matter.

## Privacy rules the server enforces (the app must not work around them)

- Event authors are hidden from everyone except the subject and moderators. `author` is `null` in every other response.
- Positions are private. Other people's holdings appear only through disclosures (Phase 2) and SEC cases.
- Liquidation and whale tape items never name the trader.
- Responses about one exchange never include another exchange's data.

## Phase tags

Every operation in `openapi.yaml` has `x-phase: 0 | 1 | 2 | later`. The app builds Phase 1 screens against Phase 0–1 operations. Phase 2 operations are drafted so the shapes are known, but the server may answer `501`.
