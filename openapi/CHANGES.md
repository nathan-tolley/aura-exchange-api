# Contract changes

One line per change to `openapi/v1.yaml`, newest first. "App" says whether the app must sync its copy (`api/openapi.yaml`) and regenerate its client.

| Date | Change | App |
| --- | --- | --- |
| 2026-10-24 | `1.0.0-draft.5`: five additive error codes for the 0.5 endpoints: `INVITE_EXPIRED` and `EXCHANGE_FULL {maxMembers}` (accepting an invite), `TICKER_TAKEN {ticker}` (IPO), `TRADING_NOT_OPEN {listedCount, minListingsToOpen}` (quotes before the market has enough listings), `INSUFFICIENT_SHARES {available}` (selling or covering more than you hold). | Yes: sync the spec and map the codes in `strings.dart` |
| 2026-10-24 | `1.0.0-draft.4`: two additive error codes for `POST /auth/email/verify` (both 401): `LOGIN_CODE_INVALID {attemptsLeft}` (wrong code) and `LOGIN_CODE_EXPIRED` (expired, superseded by a newer code, or out of its 5 tries). | Yes: sync the spec; show "wrong code" and "code expired" from these. Each code submission needs a new `Idempotency-Key` (a stored 401 is replayed for the same key and body) |
| 2026-10-24 | `1.0.0-draft.3`: declared the error responses every operation can already return. All operations: `429` (global rate limit) and `503` (maintenance). Every write: `400` (missing or malformed `Idempotency-Key`) and `409` (`IDEMPOTENCY_MISMATCH`, `IDEMPOTENCY_IN_PROGRESS`). 131 responses added, nothing else changed. | Sync the spec; no success types change |
| 2026-10-24 | `1.0.0-draft.2`: three additive error codes in `ErrorCode` and API-CONTRACT.md: `FORBIDDEN` (403), `CONFLICT` (409), `IDEMPOTENCY_IN_PROGRESS` (409, retryable, RETRY). | Yes: sync the spec; map the new codes in `strings.dart` (unknown codes already fall back to the generic screen) |
| 2026-10-24 | Initial import of the handoff draft (`1.0.0-draft.1`): 49 paths, 53 operations, each tagged `x-phase`. | Already has this copy |
