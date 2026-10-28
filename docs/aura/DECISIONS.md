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
- Mean reversion has a 2-trading-day half-life. Noise is Student-t (df 4) with **1.1%** base daily vol × personality 0.5–2.0 (the plan said 2%; changed 2026-10-28, open question 12). The tick runs every 15 s during open hours.
- Markets are open every day (2026-10-28). Exchanges hold at most 20 members (2026-10-28).
- **Design-pass additions, approved 2026-10-28:**
  - The market opens once **3 friends are listed**. Until then, Home shows the IPO-day screen.
  - Liquidation headlines **never name the person liquidated** ("One short seller forcibly removed from the position"). Nathan considered naming the person and chose to keep the privacy rule.
  - A margin warning appears at **140% collateral** and shows the exact liquidation price.

## Branching

- **API.** Changed 2026-10-28: **we fork off, with no more merges from the friend.** His repo (`karkys/Aura-Exchange`) was only the starting point.
  - `aura-v1` becomes `main` of a new **public** repo, `nathan-tolley/aura-exchange-api`, with all history kept. Work happens on `main`.
  - His repo stays as a fetch-only `upstream`, for reference. His `deeaa37` ("Add casino, Swagger docs, and claim recovery") is **not** merged.
  - Once the new repo has everything and has been checked, the `aura-v1` branch is deleted from his repo. Nothing else there is ever touched, his `master` least of all.
  - The local folder stays `The Aura Exchange\Aura-Exchange`, because the app's docs point at `..\Aura-Exchange`.
  - Before 2026-10-28 the rule was: branch `aura-v1` from his `master`, merge `master` in regularly, never push to his `master`.
- **App.** A new repo created from the template. Work on `main` with short feature branches.

## What sessions may do without asking (2026-10-28)

- **Push** to `nathan-tolley/aura-exchange-api` once the checks pass.
- **Deploy the API** to the box after a green `pnpm check` and a smoke test, and say so afterwards.
- **Node:** keep running the checks in the Node 24 Docker container (`scripts/pnpm-docker.ps1`). Leave the PC's global Node 20 alone.
- Never force-push, never push anyone's `master`, and touch the friend's repo only to delete `aura-v1` from it.

## Open questions (ask Nathan; don't guess)

1. ~~**The fork.** Is the friend (`karkys` on GitHub) OK with us forking his repo, and does he want in? Needed before anything is pushed to a shared remote.~~ Answered 2026-10-25: **the fork is OK with `karkys`** (Nathan). Pushing `aura-v1` to his remote is allowed, and `origin/aura-v1` = `192fa15` is already there. Each push still needs Nathan's OK (`CLAUDE.md`). We still never push to `master` and never force-push. Whether he wants in wasn't part of the answer.
2. ~~**Who is it for?** Just this friend group, or can anyone create an exchange?~~ Answered 2026-10-28: **anyone** can create an exchange, which is how the API already works.
3. ~~**Weekends.** Are markets open every day (proposed), or closed for a Monday gap?~~ Answered 2026-10-28: markets are **open every day**.
4. ~~**Season resets.** Do prices reset to 100 every 8 weeks (proposed)?~~ Answered 2026-10-28: **yes**. Every 8 weeks prices reset to 100, cash goes back to A$10,000, and the season's awards are given.
5. ~~**Analyst tone.** How savage? This sets the AI prompt and the moderation rules.~~ Answered 2026-10-28: **as savage, brutal and ruthless as we can push it.** The only limits are the AI provider's usage policy and the moderation hard limits: no slurs, nothing about protected traits, no sexual content about real people, nothing encouraging self-harm, and no doxxing. Everything short of that is fair game.
6. ~~**AI budget.** About how many events a day per group? This sets the model choice and cost.~~ Answered 2026-10-28: about **10–30 events a day** per group.
7. ~~**Hosting.** Fly.io, Railway or Render (plan says pick one; US-East)?~~ Answered 2026-10-25: Nathan's own Ubuntu box in the cloud, at `tae.app.elicit-marketing.com` (see "Changed since the plan").
8. ~~**Email provider** for sign-in codes (e.g. Resend or Postmark). In development, codes are printed to the server log.~~ Answered 2026-10-28: **Resend**, from the domain Nathan verified, `securedesk.elicit-marketing.com` (the only domain his API key covers; he said so on 2026-10-28). The sender is `Aura Exchange <codes@securedesk.elicit-marketing.com>`. Nathan puts the API key on the server himself; it is never pasted into chat or committed. Development and tests keep logging the code.
9. ~~**Paid Apple Developer account later?** That unlocks push, Sign in with Apple, TestFlight and the App Store.~~ Answered 2026-10-28: **yes, soon.** Plan for push (APNs), Sign in with Apple and TestFlight once Nathan has enrolled, but don't build them before the account exists. The API keeps `POST /auth/apple` and APNs delivery as *later*.
10. ~~**Prediction markets and options** (added 2026-10-24 by the API session). The friend's latest commit (`49a0eaf`) added pooled YES/NO prediction markets and system-issued call/put options to the web version. Neither is in the `/v1` contract; PLAN.md has options in Phase 3 and doesn't mention prediction markets. Proposed default: keep both working on `/api` for the web console, leave them out of `/v1` until you decide. Do you want either in the app, and when?~~ Answered 2026-10-28: both stay **on the old `/api` web console only**, out of `/v1` and the app for now.
11. ~~**Exchange size cap** (added 2026-10-24 by the API session). The app shows an "exchange full" state, but the plan never says how full is full. Default taken from PLAN.md pillar 5 ("about 4–20 people"): at most **20 members** per exchange, stored per exchange as `settings.maxMembers`. Keep 20?~~ Answered 2026-10-28: **20** members.
12. ~~**Price-engine tuning** (added 2026-10-25 by the API session, from the 0.6 simulator; details in NOTES.md → Price-engine tuning). With the plan's starting numbers, a simulated 8-week season splits daily price movement about **58 / 17 / 25** (events / trades / noise), not 60 / 25 / 15. Proposed: base daily volatility 2% → 1.1% and keep the 4,000 / A$400,000 pool. OK to make 1.1% the engine default?~~ Answered 2026-10-28: **yes.** 1.1% becomes the engine's default base daily volatility, and the 4,000-share / A$400,000 pool stays. The reasoning is in NOTES.md → Price-engine tuning: noise was too loud for the events a group can file (events ÷ noise ≈ 0.047 ÷ base vol), and with players betting 5–20% of their equity the plan's pool already brings trades to about 25%. Full seasons at the real 15 s tick land at 57.5 / 26.6 / 15.9.
