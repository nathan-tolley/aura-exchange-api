# Decisions

What's settled, what changed since the plan, and what's still open. When this file and `PLAN.md` disagree, this file wins. Add to it whenever something new is decided, with the date.

## The shape of the system (settled)

- **Two separate projects, one contract.**
  - **aura-api**: the cloud server. TypeScript, Fastify, PostgreSQL and a worker. It's a branch of the friend's repo.
  - **aura-exchange-app**: the iPhone app. Flutter, created from `flutter-ios-template`.
  - The app knows nothing about the server except the `/v1` HTTP + WebSocket contract in `openapi.yaml` and `API-CONTRACT.md`. It never reads the database and never shares code with the server.
- **The API owns the contract.**
  - A contract change starts in the API repo (`openapi/v1.yaml`). It is then copied into the app repo (`api/openapi.yaml`), and the app regenerates its client.
  - Until the API implements an endpoint, the app develops against a mock generated from the same spec (Prism). Neither side waits on the other.
- **Versioned and additive.**
  - `/v1` only grows: new fields and new endpoints.
  - Removing or renaming anything needs `/v2`, or a `minVersion` bump enforced by the server's `UPDATE_REQUIRED` error.
- **The web client stays** in the API repo as an admin console and a backup client. It is not the product.

## Changed since the plan (2026-10-24)

| Plan said | Now | Why |
| --- | --- | --- |
| iOS app in SwiftUI | **Flutter**, from `C:\Users\natha\OneDrive\Desktop\Personal\Programming Projects\flutter-ios-template` (GitHub: `nathan-tolley/flutter-ios-template`) | Development happens on Windows. A GitHub macOS runner builds an unsigned `.ipa`, which is installed with Sideloadly. |
| TestFlight pilot | **Sideloaded builds** from GitHub Releases | No paid Apple Developer account yet. Free signing lasts 7 days (Sideloadly AutoRefresh renews it). A free Apple ID allows 3 sideloaded apps per device. |
| Sign in with Apple first, email codes as fallback | **Email one-time codes only** for now. Keep `POST /auth/apple` in the contract, marked *later*. | Sign in with Apple needs the paid program. |
| APNs push notifications | **In-app notification inbox plus live WebSocket**. The server still creates every notification record exactly as a push would, and APNs delivery is added later. | Push needs the paid program. Design the Notifications screen as the inbox. |
| Swift client generated from OpenAPI | **Dart client generated from OpenAPI** (recommended: `swagger_parser` with dio + json_serializable, which needs no Java) | Flutter |
| SF Pro / New York / SF Mono | **System sans on iOS** (SF Pro automatically). **Newsreader** and **JetBrains Mono** are bundled as font assets (both OFL). | Flutter can't reach New York or SF Mono by family name, so we bundle open fonts. That way the web preview and the device match. |
| Projects in `C:\Users\natha\Downloads\aura` | Projects in `C:\Users\natha\OneDrive\Desktop\Personal\Programming Projects\The Aura Exchange`, with the friend's repo freshly cloned there | Nathan's choice, 2026-10-24. The old Downloads copy is no longer used. |
| A managed host (Fly.io, Railway or Render) with managed Postgres in US-East | **Nathan's own Ubuntu 24.04 box in the cloud**, at `tae.app.elicit-marketing.com`. Docker Compose runs Caddy (automatic HTTPS), the API, the worker and Postgres 18 on it, using the repo's existing `compose.yaml`. | Nathan's choice, 2026-10-25. Login is by SSH key only; a dedicated deploy key (`~/.ssh/aura_deploy` on Nathan's PC). Backups are ours to run (no managed snapshots). |
| Design-system "SwiftUI notes" | The same rules apply, mapped to Flutter widgets (see `app/design/DESIGN.md`) | |

## Settled game rules (from planning and the design pass)

- Currency is **Aura Bucks**, shown as `A$`, with 2 decimals. Shares are shown to up to 4 decimals and prices to 2.
- You can never trade your own listing. You can't be long and short the same stock at once.
- Starting cash is A$10,000. Seasons last 8 weeks. Fee is 0.5% (1.5% in extended hours). Initial collateral is 150% and maintenance collateral is 125%.
- AMM pool at IPO: 4,000 shares and A$400,000 (price 100).
- News shock: `m(d) = sign(d)·0.25·(|d|/30)^1.4`. The gap is a random 40–120% of m, and the rest drifts in over 45 minutes. Fair value F = B×H, with the hype part decaying on a 3-day half-life.
- Mean reversion has a 2-trading-day half-life. Noise is Student-t (df 4) with 2% base daily vol × personality 0.5–2.0. The tick runs every 15 s during open hours.
- **Design-pass additions awaiting Nathan's OK:**
  - The market opens once **3 friends are listed**. Until then, Home shows the IPO-day screen.
  - Liquidation headlines **never name the person liquidated** ("One short seller forcibly removed from the position").
  - A margin warning appears at **140% collateral** and shows the exact liquidation price.

## Branching

- **API.**
  - Pull the friend's latest `master` first; he has been adding API endpoints.
  - Create the branch `aura-v1` from it and do all work there.
  - Merge `master` into `aura-v1` regularly; never rewrite his history.
  - Don't push to his `master`.
- **App.** A new repo created from the template. Work on `main` with short feature branches.

## Open questions (ask Nathan; don't guess)

1. **The fork.** Is the friend (`karkys` on GitHub) OK with us forking his repo, and does he want in? Needed before anything is pushed to a shared remote.
2. **Who is it for?** Just this friend group, or can anyone create an exchange?
3. **Weekends.** Are markets open every day (proposed), or closed for a Monday gap?
4. **Season resets.** Do prices reset to 100 every 8 weeks (proposed)?
5. **Analyst tone.** How savage? This sets the AI prompt and the moderation rules.
6. **AI budget.** About how many events a day per group? This sets the model choice and cost.
7. ~~**Hosting.** Fly.io, Railway or Render (plan says pick one; US-East)?~~ Answered 2026-10-25: Nathan's own Ubuntu box in the cloud, at `tae.app.elicit-marketing.com` (see "Changed since the plan").
8. **Email provider** for sign-in codes (e.g. Resend or Postmark). In development, codes are printed to the server log.
9. **Paid Apple Developer account later?** That unlocks push, Sign in with Apple, TestFlight and the App Store.
10. **Prediction markets and options** (added 2026-10-24 by the API session). The friend's latest commit (`49a0eaf`) added pooled YES/NO prediction markets and system-issued call/put options to the web version. Neither is in the `/v1` contract; PLAN.md has options in Phase 3 and doesn't mention prediction markets. Proposed default: keep both working on `/api` for the web console, leave them out of `/v1` until you decide. Do you want either in the app, and when?
11. **Exchange size cap** (added 2026-10-24 by the API session). The app shows an "exchange full" state, but the plan never says how full is full. Default taken from PLAN.md pillar 5 ("about 4–20 people"): at most **20 members** per exchange, stored per exchange as `settings.maxMembers`. Keep 20?
12. **Price-engine tuning** (added 2026-10-25 by the API session, from the 0.6 simulator; details in NOTES.md → Price-engine tuning). With the plan's starting numbers, a simulated 8-week season splits daily price movement about **58 / 17 / 25** (events / trades / noise), not 60 / 25 / 15.
    - **Noise is too loud for the events a group can file.** Event share barely grows with more filings, because each event also spikes volatility: 2.5 rulings per listing per day still only gives 65 / 13 / 22, and 4 : 1 at 2% would take about 5 per listing per day. Proposed: **base daily volatility 2% → 1.1%** (personality 0.5–2.0 unchanged).
    - **Trading is too quiet with small bets, but the pool can stay.** With the 4,000-share pool, simulated players who bet 5–20% of their equity per trade (play money; the plan sized the pool for "one full starting balance moves price about 5%") bring trades to about 25%. The alternative is a 2,000-share pool, where A$10k moves price about 10%. Proposed: **keep the 4,000 / A$400,000 pool**.
    - Everything else stays at the plan's numbers: the m(d) curve, the 40–120% gap, the 45-minute drift, the 3-day hype and 2-trading-day reversion half-lives, and the 3× / 2-hour volatility spike (it barely matters: 1× → 3× moves noise from 25% to 27%).
    - Result: about **58–59 / 26–27 / 14–16** over full seasons (3 seasons at the real 15 s tick: 57.5 / 26.6 / 15.9). Until you agree, the engine's default stays at 2% and only the simulator uses 1.1%. OK to make 1.1% the engine default?
