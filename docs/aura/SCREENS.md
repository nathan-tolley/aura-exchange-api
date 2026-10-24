# Screens and states

The app has 32 screens. A screen is done only when **every state in its row** is built and reachable, both in the app and in the debug state gallery (see the app's `CLAUDE.md`).

- **Design**:
  - "Drawn" means a pixel reference exists. These are W01–W13, the worst moments, which were designed first.
  - "Next" means build the screen from the design system rules and components, following the drawn screens' patterns. Don't invent new patterns.
- **Endpoints**: what the screen needs from `openapi.yaml`.
- **Reference** images are in `design/reference/screens/` in the app repo (`app/design/reference/screens/` in the handoff folder).
- **Live design canvas** (Nathan can open it): https://claude.ai/artifact/LfP7JBH1MaZMu2g3vJbttL
- **Live design system**: https://claude.ai/artifact/HTvUeLfUk5wZrkDwLrCTNt

| # | Screen | States to build | Phase | Design | Endpoints | Reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Sign in | Email code entry, code sent, wrong code, code expired, no network | 1 | Next | POST /auth/email/start, /auth/email/verify, /auth/refresh |  |
| 2 | Join an exchange | Invite preview (who's listed), invite expired, exchange full | 1 | Next | GET /invites/{code}, POST /invites/{code}/accept |  |
| 3 | Your IPO | Consent to be listed, pick a ticker, ticker taken, listed | 1 | Next | GET /exchanges/{id}/tickers/check, POST /exchanges/{id}/listing |  |
| 4 | Create an exchange | Name, timezone and hours, invite friends, waiting for friends | 1 | Next | POST /exchanges, POST /exchanges/{id}/invites |  |
| 5 | Home | Default, loading, brand-new exchange (IPO day), market closed, offline | 1 | Partly drawn (closed, offline, IPO day) | GET /exchanges/{id}/market, /portfolio, /stream | `W09-MarketClosed.png`, `W11-Offline.png`, `W12-EmptyExchange.png` |
| 6 | Market list | Sorted by change, halted rows, search results, no results | 1 | Next | GET /exchanges/{id}/market |  |
| 7 | Stock page | Default, your own stock, halted, closed with indicated price, rumor pending, delisted | 1 | Partly drawn (halted) | GET /listings/{id}, /listings/{id}/candles | `W10-Halted.png` |
| 8 | Stock overview | Default, no events yet | 1 | Next | GET /listings/{id}, /exchanges/{id}/events?listingId= |  |
| 9 | Trade sheet | Buy, sell, short, cover, limit order (extended hours), stop-loss | 1 | Partly drawn (buy) | POST /quotes, /trades, /orders | `W05-TradeRejected.png` |
| 10 | Order outcomes | Quote expiring, requote with the difference, rejected (cash, size, short cap), filled receipt, resting order | 1 | Partly drawn (rejected, requote) | POST /quotes (previousQuoteId), /trades | `W05-TradeRejected.png`, `W06-Requote.png` |
| 11 | File an event | Compose, pick subject, add receipts, self-filing note, daily limit hit, discard | 1 | Next | POST /uploads, /events |  |
| 12 | Your filing's status | Sending (30-second unsend), rumor live, ruled, halted for a vote, voided | 1 | Next | GET /events/{id}, POST /events/{id}/unsend, stream status |  |
| 13 | Rumor | Teaser, co-sign or cap, insider notice, countdown | 1 | Next | GET /events/{id}, POST /events/{id}/reactions |  |
| 14 | Rumor about you | Heads-up, respond (no comment / deny) | 1 | Drawn | GET /events/{id}, POST /events/{id}/statement | `W01-RumorAboutYou.png` |
| 15 | Ruling | Public view, up/down votes, conflicted voters, correction after an appeal | 1 | Next | GET /events/{id}, POST /events/{id}/votes |  |
| 16 | Ruling on you | Loss, gain, queued for the open, story hidden | 1 | Drawn | GET /events/{id}, POST /events/{id}/appeal | `W02-RulingOnYou.png` |
| 17 | News halt vote | Confirm / decline / reconsider, countdown, result | 1 | Partly drawn (voting) | POST /halts/{id}/votes | `W10-Halted.png` |
| 18 | Tape | All, filtered, empty, unread | 1 | Next | GET /exchanges/{id}/tape, stream tape |  |
| 19 | Notifications | Inbox grouped by stock, quiet hours on, empty | 1 | Next | GET /me/notifications, POST /me/notifications/read |  |
| 20 | Portfolio | Positions and cash, open orders, empty | 1 | Next | GET /exchanges/{id}/portfolio, DELETE /orders/{id} |  |
| 21 | Margin warning | Banner and sheet with the liquidation price | 1 | Drawn | GET /positions/{id}, POST /positions/{id}/close | `W07-MarginWarning.png` |
| 22 | Liquidated | Receipt: what sold, at what price, what came back | 1 | Drawn | GET /positions/{id}, notification LIQUIDATED | `W08-Liquidated.png` |
| 23 | Closed, halted, offline | App-wide banners, trading disabled with reasons | 1 | Drawn | Freshness on every payload; errors MARKET_CLOSED, LISTING_HALTED | `W09-MarketClosed.png`, `W10-Halted.png`, `W11-Offline.png` |
| 24 | Server error, update required | Retry, update | 1 | Drawn | GET /health; errors SERVER, MAINTENANCE, UPDATE_REQUIRED | `W13-ServerError.png` |
| 25 | SEC charge | Case file, fine receipt | 2 | Drawn | (Phase 2: /me/sec-cases) | `W03-SECCharge.png` |
| 26 | Bankruptcy | Offer at the moment of the loss, Chapter 7 confirm, badge | 2 | Drawn | POST /exchanges/{id}/bankruptcy | `W04-Bankruptcy.png` |
| 27 | Earnings | Estimate entry, Sunday survey, results | 2 | Later | (Phase 2) |  |
| 28 | 13F reveal | Sunday top holders and shorts | 2 | Later | (Phase 2) |  |
| 29 | Leaderboards and awards | Season leaders, season-end awards | 2 | Later | GET /exchanges/{id}/leaderboards |  |
| 30 | You | Your listing, stats, super-injunctions left | 1 | Next | GET /me, /listings/{myListingId} |  |
| 31 | Settings | Notifications, quiet hours, opt out of being listed | 1 | Next | PATCH /me/notification-prefs, DELETE /exchanges/{id}/listing |  |
| 32 | Admin | The Fed (rates), moderation queue, appeals | 1 | Later (use the web console) | PATCH /exchanges/{id}/settings |  |

## The 13 drawn worst moments

| Ref | Screen | What it shows |
| --- | --- | --- |
| W01 | Rumor about you | A heads-up during the rumor; the spec row (ruling countdown, co-signs, receipts); ways to respond |
| W02 | Ruling on you | The impact number; the landing price queued for the open; serif headline; analyst quote; the spec row; statement, super-injunction and appeal |
| W03 | SEC charge | The case line; serif headline; the fine as the hero number; a receipt of the case; the follow-on scandal and the appeal |
| W04 | Wiped out | The Chapter 7 offer at the moment of the loss; what you get and give up; the tape line; slide-to-confirm in the down color |
| W05 | Trade rejected | Trade sheet with the stepper; a receipt with the fee as its own row; a banner with the exact shortfall and a fix ("Buy 18"); a disabled Buy button |
| W06 | Requote | Old vs new total; a countdown for the new quote; slide to buy at the new price; a ghost "Don't buy" button |
| W07 | Margin warning | A range bar from entry to liquidation; collateral vs the minimum; Cover 30 and Cover all |
| W08 | Liquidated | A ledger receipt (collateral − buyback − fee = returned); a tape line that doesn't name you |
| W09 | Home, closed | The tape; hero number; two actions; a closed banner that explains the gap; a watchlist with the "Ruled" tag |
| W10 | Halted | Halt status; vote countdown; serif headline with the impact; the vote list; disabled Sell and Buy with the reason |
| W11 | Home, offline | An offline banner with Retry; "as of 9:41 pm" everywhere; disabled actions |
| W12 | Home, IPO day | A one-item tape; starting cash; 1 of 3 listed; the invite list; the Analyst's first line |
| W13 | Exchange down | A calm explanation; what's safe; a receipt of the current state; the tape line; Try again |
