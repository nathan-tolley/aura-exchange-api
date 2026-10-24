# The Aura Exchange — Logic Plan

> Exported from the planning doc on 2026-10-24. This is the product and game-design source of truth.
> **Read `DECISIONS.md` first** — a few platform choices changed after this plan was written:
> the iPhone app is **Flutter** (built from `flutter-ios-template`, sideloaded), not SwiftUI, and
> sideloading on a free Apple ID rules out push notifications and Sign in with Apple for now.
> Where this file and `DECISIONS.md` disagree, `DECISIONS.md` wins.

## The pitch

The Aura Exchange is a play-money stock market where every friend in the group is a listed stock, and the price moves mostly on the dumb stuff that happens to them that day. You trade your friends, not yourself. The joke works only if the market is real enough that a finance bro would nod along — so the rule is: every real market mechanic gets a deadpan aura version, and the app never winks at the camera.

**Design pillars**

1. **Deadpan realism.** Bloomberg-terminal seriousness applied to "Jake tripped in front of his crush." The headline reads `JAKE SHARES PLUNGE 14% AFTER CURBSIDE INCIDENT; ANALYSTS CITE 'STRUCTURAL WEAKNESS IN ANKLES'`.
2. **Events drive price.** Price is roughly 60% news, 25% trading flow, 15% noise. If nothing happens to you, your stock drifts and gets boring — exactly like a real stock with no catalysts.
3. **You are not your stock.** Each person has two separate things: a listing (their aura stock, which others trade) and a brokerage account (their cash and positions). You can get rich shorting yourself into irrelevance in theory — except that's insider trading, and the SEC is watching.
4. **Every mechanic is a punchline.** Short squeezes, circuit breakers, earnings beats, 13F filings, reverse splits and Chapter 11 all exist because each one is a joke waiting for the right moment.
5. **Small private groups.** One exchange = one friend group (about 4–20 people). A person can be listed on several exchanges. Nothing is public outside the group.
6. **API first.** The product is a cloud API plus an iPhone app. The web client becomes one more consumer of the same API.
7. **Every state is designed.** The joke is the content; the craft is in the states around it. Loading, empty, closed, halted, offline, liquidated and roasted all get a real screen (see Quality bar).

## What the existing web version gives us

The friend's repo (Aura-Exchange, about 3,600 lines of TypeScript) is a solid engine to fork: Fastify API, PostgreSQL, a background worker, a double-entry cash ledger, a constant-product market maker, shorts with liquidation, limit orders, an AI judge, voting and seasons. The trading plumbing is genuinely good. The core game loop is not.

**The key gap: events don't move the price.** An AI-judged event changes a separate `seasonal_aura` score, which only pays a weekly dividend. Price moves only from trades and a bounded ±3% random wiggle. So a legendary fumble barely touches the chart — the opposite of what we want. Worse, the coupling runs backwards: buying a stock *adds* aura to the person. Fixing this is the first job of the fork (see The price engine).

| Area | What exists | Decision |
| --- | --- | --- |
| Ledger | Immutable double-entry cash ledger, balanced postings, DB triggers block edits | Keep as is |
| Market maker | Constant-product AMM, 0.5% fee, 10%-of-pool order cap, 15-second quotes, stale-quote protection | Keep; add a fair-value anchor and news shocks |
| Shorts | 150% initial collateral, 125% maintenance, auto-liquidation, daily borrow fee, exposure caps | Keep; make borrow rate a group setting ("the Fed") |
| Limit orders | Buy/sell limits with reserved cash | Keep; add stop-loss and take-profit |
| Ambient motion | Random walk clamped to ±3% of last trade price | Replace with the new noise + mean-reversion model |
| Aura score | Separate number moved by rulings, votes and trades | Merge into the price engine as "fair value"; drop trade-to-aura coupling |
| AI judge | Provider-neutral, structured output, policy flags, low-confidence goes to human review | Keep; extend output with headline, category and analyst note |
| ChatGPT-plan judge | Uses an owner's personal ChatGPT login tokens to run the judge | Drop; use a normal API key |
| Voting | Up/down votes change a ruling by 10% each | Keep, with a cap |
| Aura Farming | Polls on rulings over 15 points: support, decline or reconsider | Keep; rename to a trading halt "pending news" |
| Seasons | 8 weeks, 10,000 starting cash, 1,000 weekly allowance, weekly dividends | Keep the shape; tune numbers |
| Auth | Cookie sessions + CSRF, invite codes, roles | Change to token auth for iOS; keep invites and roles |
| Tenancy | One exchange per server | Change to many exchanges per server |
| Hosting | Docker Compose on a home Windows PC with Caddy | Change to a cloud host |
| Web client | React dashboard | Keep as reference and as an admin console |

Net: fork it, keep roughly the ledger, AMM, shorting, limit orders, judge and moderation code, and rewrite the price engine, tenancy and auth.

## Core concepts

Eight nouns run the whole game; everything else is built from them.

| Term | What it is | Notes |
| --- | --- | --- |
| Exchange | One friend group's private market | Has its own timezone, market hours, settings and admin ("the Fed") |
| Member | A person in an exchange | Has exactly one listing and one brokerage account per exchange |
| Listing | A member's aura stock, e.g. `$NATE` | 3–5 letter ticker, IPOs at 100.00, 1,000,000 shares outstanding (display only) |
| Brokerage account | A member's cash and positions | Fully separate from their listing; cannot hold their own stock |
| Aura Bucks (A$) | The play-money currency | No real-money value, cannot be bought or cashed out, ever |
| Event ("filing") | Something that happened to a member, submitted by anyone | Goes through rumor, ruling and voting; moves price |
| The Analyst | The AI that rules on events | Writes the headline, sets the impact score, issues ratings |
| Season | An 8-week competition window | Cash and prices reset; career stats and lore persist |

Two derived numbers matter everywhere:

- **Price** — what the stock trades at right now, set by the market maker.
- **Fair value** — what the stock "should" be worth given its events. Hidden from players as a raw number, but leaked through analyst price targets. Price is pulled toward fair value over time, which is what makes news stick and pumps fade.

## The price engine

Price is a market-maker price that gets yanked by news, pushed by trades, jittered by noise, and slowly pulled back toward fair value. Four forces, one update every tick. Tuning target: over a season, roughly 60% of each stock's movement should trace back to events, 25% to trading flow and 15% to noise.

### State per listing

- **P** — spot price, read from the market maker's reserves (credits ÷ shares), exactly as today.
- **F** — fair value, = B × H. **B** is the permanent base; **H** is a hype multiplier that decays back to 1.
- **σ** — current volatility, a base "personality" level that spikes after news.
- **Drift queue** — news impact that hasn't hit the price yet.

### Force 1: news shocks

When an event's ruling is final, its impact score d (−30 to +30, after votes) converts to a percentage move m on a convex curve, so small stuff is small and legendary stuff is huge:

```latex
m(d) = \operatorname{sign}(d) \cdot 0.25 \cdot \left(\frac{|d|}{30}\right)^{1.4}
```

| Impact score | Example | Move |
| --- | --- | --- |
| 3 | Said something mildly funny | 1.0% |
| 5 | Showed up with snacks for everyone | 2.0% |
| 10 | Hit a half-court shot on the first try | 5.4% |
| 15 | Got left on read, publicly | 9.5% |
| 20 | Called the teacher "mom" in front of 30 people | 14.2% |
| 30 | Once-a-season legendary or catastrophic | 25.0% |

What happens next:

1. **F moves the full m immediately.** Half goes into B (permanent), half into H (hype that fades with a 3-day half-life). Aura is real, but clout fades.
2. **P gaps part of the way, at random.** The instant gap is a random 40–120% of m. Under 100% means the market under-reacts and drifts the rest; over 100% means it overreacts and then sells off. Both are real and both are funny.
3. **The rest drifts in over 45 minutes** through the drift queue ("post-news drift").
4. **Volatility spikes** to as much as 3× base and decays with a 2-hour half-life, so a stock is jumpy right after drama.

### Force 2: trades

Trades hit the constant-product market maker exactly as the current code does. The change is depth: the pool is sized so one full starting balance moves price about 5%, and a coordinated group can move it a lot.

- Pool at IPO: 4,000 shares and 400,000 A$ (40× the 10,000 starting balance), price 100.
- A 10,000 A$ buy moves price +5.1%. Five friends piling in 50,000 A$ moves it about +27%.
- That's deliberate: pumps are possible, which is what makes pump-and-dump detection and short squeezes work.

### Force 3: mean reversion

Every tick, price is pulled toward fair value with a 2-trading-day half-life. A pump without news fades; a crash without news recovers; a real event sticks because F moved with it. This is the "fundamentals" layer that makes shorting a hyped stock a real strategy.

### Force 4: noise

Random log-return each tick from a fat-tailed distribution (Student-t, 4 degrees of freedom), so most ticks are tiny and the occasional one is a weird spike for no reason. Base daily volatility 2%, times a per-listing personality multiplier of 0.5–2.0 that the engine learns from how often a person generates events. Chaotic friends are high-beta stocks.

### The tick

One update every 15 seconds during open hours:

```latex
\ln P_{t+1} = \ln P_t + \kappa\,(\ln F_t - \ln P_t)\,\Delta t + \delta_t + \sigma_t \sqrt{\Delta t}\;\varepsilon_t
```

Here κ sets the 2-day reversion half-life, δ is this tick's slice of the drift queue, and ε is the fat-tailed noise. The engine then re-solves the reserves to the new price while keeping the pool's constant product, the same trick the current ambient-motion code uses. Trades between ticks move P directly.

### Quiet decay

After 3 days with no ruled events, fair value bleeds 0.5% a day (capped at 5%), and the Analyst posts a note like "$NATE has not done anything in four sessions; we are lowering our price target." It nudges people to keep filing. Can be turned off per exchange.

### Market hours

Per exchange, in its own timezone. Defaults:

| Session | Hours | Rules |
| --- | --- | --- |
| Pre-market | 7:00–9:00 am | Limit orders only, 1.5% fee |
| Regular | 9:00 am–10:00 pm | Everything, 0.5% fee |
| After-hours | 10:00 pm–2:00 am | Limit orders only, 1.5% fee |
| Closed | 2:00–7:00 am | No ticks, no trades; events still filed |

Events ruled while closed queue up and hit together when pre-market opens at 7:00, as one opening gap, so the 2 a.m. chaos produces a proper "futures are down" morning.

### Guard rails

- **Single-stock halt:** a 10% move inside 5 minutes halts that stock for 5 minutes ("limit up / limit down").
- **News halt:** an event scored over 15 halts the stock while the group votes on it (see the event pipeline).
- **Market-wide breaker:** the exchange index down 7% on the day halts everything for 15 minutes; down 20% closes the market until the next open.
- **Splits:** price over 1,000 triggers a 10-for-1 split. Price under 1.00 for 3 sessions triggers "Chapter 11": a 1-for-10 reverse split and a very public headline.

All numbers here are starting values. Before launch, a simulator script replays a fake season of events and trades so we can tune toward the 60/25/15 target.

## The event pipeline

Every event goes filed → rumor → ruling → (vote if huge) → price → community votes, and the 10-minute rumor window is the best mechanic in the game: you can buy the rumor and sell the news.

```
filed ──► SENDING (30 s, can unsend) ──► RUMOR (10 min: teaser, co-signs, caps, subject statement)
      ──► RULING (the Analyst) ──► RULED: price shock ──► up/down votes (2 h) ──► appeal (7 days)
side routes after the ruling:
  hard policy flag ............ REVIEW (moderators; never shown in the tape)
  confidence < 0.75 or REVIEW . REVIEW (moderators)
  |impact| > 15 ............... HALTED: group vote 30 min → Confirm / Decline (VOIDED) / Reconsider (final re-rule)
```

Most events take the top row in about 10 minutes; only flagged, uncertain or huge ones branch off.

### 1. Filing

Anyone can file about anyone in the exchange, including themselves. A filing has text (8–800 characters), optional receipts (up to 4 photos, screenshots or a 30-second clip), and an optional "when it happened." The author is hidden from everyone except moderators and the subject, as the current code already does.

Limits carried over or added:

- 10 filings per author per day (existing).
- After 5 ruled events on one subject in a day, further ones count at half impact (pile-on protection).
- A near-duplicate of a recent filing on the same subject merges into it as a co-sign instead of a new event.
- Self-filed gains ("press releases") count at half impact. Analysts are skeptical of company-issued guidance.

### 2. Rumor phase (10 minutes)

The feed shows a teaser the Analyst writes without the details: `UNCONFIRMED: Reports of an incident involving $JAKE near the cafeteria. More to follow.` The stock trades normally, so people who think they know what happened can move first.

During the rumor:

- **Co-sign ("I saw it")** — each one raises the eventual impact 10%, up to +30%, and raises confidence.
- **Cap ("didn't happen")** — each one lowers impact 10%, down to −30%.
- **Subject statement** — the subject can post "No comment" or "Deny." A denial followed by a confirmed loss takes an extra 20% hit ("$JAKE denied the allegations. The allegations were true.").
- **Insider rule** — the author and any co-signer are flagged insiders for this event until 30 minutes after it rules (see Trading).

### 3. Ruling

The Analyst gets the text, receipts, co-sign and cap counts, the subject's statement, the exchange's lore glossary, and the subject's recent history. It returns:

| Field | Example |
| --- | --- |
| Verdict | LOSS |
| Impact score | −12 |
| Confidence | 0.86 |
| Category | GUIDANCE CUT |
| Headline (wire style, 90 chars max) | JAKE SHARES SLIDE AS 'GYM EVERY DAY' PLEDGE ENTERS FOURTH WEEK OF NON-COMPLIANCE |
| Analyst note (280 chars max) | We are moving to Underweight. Management continues to talk about leg day without delivering it. |
| Policy flags | none |

Categories are a fixed list so the app can give each its own icon: EARNINGS BEAT, EARNINGS MISS, SCANDAL, PRODUCT LAUNCH, MERGER (got together), DIVESTITURE (broke up), GUIDANCE CUT, MANAGEMENT SHAKEUP (new haircut), REGULATORY ACTION (in trouble with parents, a teacher or a boss), and LORE (funny, zero impact).

Routing after the ruling, mostly as the current code does:

- **Hard policy flag** (threats, personal data, harassment, sexual content, protected-class attacks) → held for moderator review, never shown in the feed.
- **Confidence under 0.75 or verdict REVIEW** → moderator review.
- **Impact over 15** → news halt and group vote (step 4).
- **Otherwise** → final; price shock applied immediately.

### 4. News halt and group vote (big events only)

The stock halts ("TRADING HALTED — NEWS PENDING"). The group has 30 minutes to vote Confirm, Decline or Reconsider — the current Aura Farming poll, renamed. Confirm applies the ruling; Decline voids it; Reconsider sends it back to the Analyst once more with the votes attached, and that second ruling is final. Voters get a small participation reward (existing: 100 A$). Trading resumes with the gap.

### 5. After the ruling

- **Up/down votes** for 2 hours. Each net vote changes impact by 10% of the original, capped at ±50%. Changes apply as small follow-on shocks. Votes from people holding a position in that stock show a "conflicted" tag.
- **Appeals** by the subject within 7 days go to the exchange admin. An overturned ruling applies the opposite shock and posts a correction: "An earlier version of this story overstated the size of the fish."

### Final impact

```latex
d_{final} = d_{analyst} \times c_{cosign} \times c_{self} \times c_{pileon} \times c_{denial} \times c_{votes}
```

Clamped to −30…+30, then turned into a price move by the curve in The price engine.

## Trading

Most of trading already works in the current code; the additions are stop orders, a real short-squeeze loop, disclosure, and the SEC.

### Orders

| Order | Status | Notes |
| --- | --- | --- |
| Market buy / sell | Exists | Quote valid 15 s, executes only against the exact reserves quoted |
| Short / cover | Exists | 50% margin up front (150% collateral), liquidated under 125% |
| Limit buy / sell | Exists | Cash reserved; checked every tick |
| Stop-loss / take-profit | New | Trigger becomes a market order; the only order type allowed to fire during a halt's reopen |
| Close position | Exists | One tap to flatten |
| Margin buy (2×) | Phase 3 | Brings margin calls to the long side |
| Options (calls / puts) | Phase 3 | Cash-settled, priced from the stock's own volatility; "0DTE puts on Jake before his date" |

Rules kept from the current build: you can never trade your own stock; you can't be long and short the same stock at once; single orders are capped at 10% of the pool; shorts are capped at 20% of equity per stock and 50% in total.

### Short squeezes

Short interest (shares shorted ÷ pool shares) is shown on every stock. Over 20% the stock gets a "Hard to borrow" badge and the borrow fee climbs from 0.1% a day toward 1% a day. Liquidations are forced market buys, so one liquidation pushes price up and can trip the next. If enough people short Jake and then Jake gets a girlfriend, the squeeze happens by itself, no special code.

### Disclosure ("13F filings")

Positions are private day to day. Every Sunday at 6 pm the exchange publishes each stock's top 3 holders and top 3 short sellers by name. Everyone finds out who has been betting against them. This is the single most drama-generating feature on the list.

### Insider trading and the SEC

The Social Exchange Commission is a bot. Insiders are allowed to trade — that's the joke — but they can get caught.

- **Who is an insider:** the author and co-signers of an event, from filing until 30 minutes after its ruling.
- **What gets reviewed:** any insider trade in the subject's stock in that window.
- **Chance of investigation:** 25%, plus 1% per 100 A$ of profit, capped at 90%. Small, lucky trades usually slip through; greed doesn't.
- **If caught:** profit is clawed back plus a 50% fine, and the SEC files a SCANDAL event against the insider's own stock (impact −8). Headline: `SEC CHARGES $NATE WITH TRADING ON NONPUBLIC CAFETERIA INFORMATION`.
- **Pump-and-dump watch:** if three or more accounts buy a stock, move it 10% or more with no event, and sell within 2 hours, the SEC opens a public "inquiry" (a warning headline first time, fines after).

### Corporate actions on yourself (Phase 3, opt-in)

You still can't trade your own stock, but you could run corporate actions on it, publicly announced:

- **Buyback:** spend your own cash to buy and retire your shares. Price goes up; the headline calls it desperate. Once a week at most.
- **Secondary offering:** issue new shares of yourself into the pool for cash. Price falls ("dilution"). For when you're broke and shameless.

## Economy and seasons

Money enters through a starting balance, a weekly allowance, dividends and rewards, and leaves through fees, fines and bad trades; seasons reset the cash so a late joiner can still win. Amounts below are in Aura Bucks.

### Cash flows

| Flow | Amount (Aura Bucks) | When | Status |
| --- | --- | --- | --- |
| Season starting balance | 10,000 | Season start, or on joining | Exists |
| Allowance ("stimulus check") | 1,000 | Mondays 9 am | Exists |
| Aura dividend | 0.25 per share per point of net positive impact that week | Mondays 9 am | Exists; base it on final impact |
| Group-vote participation | 100 | When a news-halt vote closes | Exists |
| Earnings estimate bonus | 200 to the closest estimate | Sunday earnings | New |
| Trading fee | 0.5% (1.5% extended hours) | Every trade | Exists |
| Borrow fee | 0.1%–1% of short value per day | Daily | Exists; make it variable |
| SEC fine | Profit + 50% | When caught | New |

Shorts pay the dividend on the shares they owe, as the current code does.

### Earnings season (weekly)

Every listing reports "earnings" Sunday at 8 pm, after hours, so the price gaps on the report.

1. By Friday midnight, members can submit an estimate of each friend's week on a 1–10 vibe scale. The median is the **consensus**.
2. Sunday afternoon, each member gets a 30-second survey: rate everyone's week 1–10. The average is the **actual**.
3. At 8 pm the beat or miss lands: impact = 6 × (actual − consensus), clamped to ±18, through the normal price curve.
4. Headline: `NATE BEATS ON VIBES, 7.4 VS 6.1 EXPECTED; SHARES JUMP 9% AFTER HOURS`. Closest estimate wins 200 and "Analyst of the Week."

This rewards forecasting your friends and creates the classic "good week, but not as good as expected" sell-off.

### The Fed

The exchange admin is the Fed. Once a week at most, they can set the base borrow rate (0.05%–0.5% a day) and the allowance size. Each change publishes an AI-written statement: "The Committee judges that risks to aura remain tilted to the downside."

### Personal bankruptcy

If a trader's equity drops under 100, they can declare bankruptcy: reset to 2,000, a public headline, and a "Chapter 7" badge for the rest of the season. Nobody gets stuck unable to play.

### Seasons

8 weeks. At season end, cash and prices reset (pools back to 100) and awards are handed out. Career stats, trophies and lore carry over.

| Award | Goes to |
| --- | --- |
| Trader of the Season | Highest net worth |
| Best Performing Stock | Biggest price gain over the season |
| Biggest Fumble | Biggest price loss |
| Top Short Seller | Most profit from shorts |
| Bagholder of the Season | Largest unrealized loss at the close |
| Most Volatile | Highest realized volatility |
| SEC Most Wanted | Most fines |

## The parody layer

The comedy lives in this table: each row is a real market concept, its aura version, and the line the app says when it happens. Anything new we add should earn a row here first.

| Real market | On the Aura Exchange | What the app says |
| --- | --- | --- |
| IPO | Joining an exchange | "$NATE prices IPO at 100.00; underwriters cite 'strong vibes, limited track record'" |
| Earnings beat / miss | Weekly vibe check vs consensus | "Beats on vibes, misses on rizz" |
| Guidance | Promises about yourself ("I'm going to the gym this week") | "$JAKE reaffirms full-year leg-day guidance" |
| Merger | Started dating someone | "$MIA announces merger; regulators reviewing" |
| Divestiture | Breakup | "$MIA completes divestiture of underperforming asset" |
| Management shakeup | New haircut, new style | "Board approves bold restructuring above the ears" |
| Regulatory action | Got in trouble with parents, a teacher or a boss | "$SAM receives cease-and-desist from Mom" |
| SEC | The insider-trading bot | "SEC charges $NATE with trading on nonpublic cafeteria information" |
| Short squeeze | Everyone shorted you, then you won | "Bears obliterated as $JAKE rips 60%" |
| Trading halt | Event too big; group votes | "TRADING HALTED — NEWS PENDING" |
| Circuit breaker | Whole group had a bad night | "Markets halted after Composite drops 7%; futures point to rough Monday" |
| Opening gap | Stuff that happened at 2 am | "$ELI indicated down 12% pre-market" |
| Analyst rating | The Analyst's weekly Buy / Hold / Sell | "Downgrade to Sell; price target 74. Too much talking, not enough doing" |
| 13F filing | Sunday top-holder reveal | "Revealed: $ANNA's largest short seller is her roommate" |
| Bagholder | Holding at a big loss | Badge on the portfolio screen |
| Penny stock | Price under 5 | "OTC Pink" badge and a warning label |
| Chapter 11 | Price under 1 for 3 sessions | "Emerges from Chapter 11 after 1-for-10 reverse split" |
| Stock split | Price over 1,000 | "Announces 10-for-1 split to make aura more accessible to retail" |
| Meme stock | Volume 5× normal with no news | "Retail frenzy" flame badge |
| Bear / bull market | Composite down / up 20% from a peak | "It's official: we are in a bear market" |
| Recession | Composite down two weeks running | "Economists declare aura recession" |
| The Fed | Exchange admin setting rates | "Committee holds rates; sees transitory cringe" |
| Dividends | Weekly payout for good weeks | "$NATE declares 3.25 per-share aura dividend" |
| Margin call | Short is about to be liquidated | Push: "MARGIN CALL on your $JAKE short. Deposit or be liquidated." |
| Delisting | Leaving the group or opting out | "$TOM delisted; holders cashed out at last price" |

### Voice rules for the Analyst

- Wire-service headlines, all caps in the ticker tape, never a joke announced as a joke.
- Finance words for life events ("guidance," "headwinds," "priced in," "structural"), plain words for everything else.
- Roast the event, never the person's identity, body or anything they can't change.
- Every headline under 90 characters; every analyst note under 280.

## Social, notifications and safety

The feed and push notifications are where the game actually happens; the safety rules are what keep a roast game from turning into a bullying app.

### The tape (feed)

One chronological feed per exchange, with these item types: rumors, rulings, news halts and votes, big trades ("Whale alert: an undisclosed fund bought 8,000 of $MIA" — the trader stays anonymous), liquidations, SEC actions, earnings, analyst ratings, Fed statements, splits and Chapter 11s, and the daily wraps. Each stock also gets its own thread for comments and "DD" posts.

Two AI-written daily pieces:

- **Opening bell (9 am):** overnight movers, events queued for the open, earnings coming up.
- **Closing bell (10 pm):** top gainers and losers, the day's biggest story, the Composite's move, one line of market commentary.

### Push notifications

| Trigger | Example | Default |
| --- | --- | --- |
| A rumor about you | "Unconfirmed reports about you are circulating. Respond?" | On |
| A ruling about you | "$NATE −9.5% after ruling. Read the headline." | On |
| A holding moves 5% or more | "$JAKE +11% — you're long 40 shares" | On |
| Margin call / liquidation | "MARGIN CALL on your $JAKE short" | On, can't turn off |
| Halt and vote opens | "$MIA halted — vote within 30 min" | On |
| 13F reveal | "Your largest short seller has been revealed" | On |
| SEC charge | "The SEC has charged you." | On |
| Earnings survey | "Rate everyone's week — 30 seconds" | On |
| Price alert | User-set level hit | On when set |
| Opening / closing bell | Daily wrap | Off |

Quiet hours per user; margin calls and SEC charges still come through.

### Privacy

- Nothing leaves the exchange. No public profiles, no cross-exchange visibility.
- Positions are private except through the Sunday 13F reveal and SEC actions.
- Event authors stay hidden from everyone except moderators and the subject (existing behavior).

### Consent and safety

- Being listed needs the member's explicit consent; opting out delists them and cashes holders out at the last price (existing).
- People outside the exchange can't consent, so the Analyst redacts their names ("a person not on the exchange") and never rules an event *about* them.
- Hard policy flags hold an event for moderators before anyone sees it (existing).
- Each member gets 3 "super-injunctions" a season: hide a ruled event about themselves from the feed. The price impact stays; the story disappears.
- Report and block on every event, comment and member, plus a contact address. Apple requires all of these for apps with user-generated content.
- Aura Bucks have no real-money value and can never be bought or cashed out, which keeps the app a game and out of gambling rules.

## Quality bar

The app will feel premium because of the states most apps skip, not because of a prettier home screen. Anyone can generate a decent-looking stock app now; what people notice is whether every moment was thought through. Three rules, taken from [The Psychology of Premium Apps](https://www.youtube.com/watch?v=8EAYZe6y3I8) (Tim Gabe):

1. **Every action answers three questions:** what just happened, can I take it back, and what do I do next.
2. **One product, not 80 screens:** one pattern per situation, used everywhere. Inconsistency slows people down more than they notice or report.
3. **Design the worst moments first:** a failure handled well can leave people happier than if nothing had gone wrong (the "service recovery paradox").

One rule of our own sits on top: **funny where the market is, clear where your money is.** Headlines can roast; error messages and confirmations say exactly what happened and how to fix it.

### 1. What happened, take it back, what's next

| Moment | What just happened | Take it back | What's next |
| --- | --- | --- | --- |
| Filing an event | "Filed. The rumor goes live in 30 seconds." | Unsend within 30 seconds | A status track: filed → rumor → ruling, with pushes |
| Placing a trade | A receipt: shares, average price, fee, new cash balance | Not possible (it's a market), so a preview and slide-to-confirm come first | Open the position; offer a stop-loss |
| Quote went stale | "The price moved 0.8% while you were looking" | — | One-tap requote that shows the old and new price |
| Limit or stop order | "Resting at 95.00" | Cancel any time | Push when it fills |
| Co-sign or cap | "You're an insider on this until 1:21 pm" | Withdraw while the rumor is open | Countdown to the ruling |
| Voting | Count updates in place | Change your vote until it closes | Countdown to close |

### 2. One product

Before designing any screen, write a pattern inventory. Each pattern is one component with one copy rule, used everywhere:

- **Price change:** sign, arrow and color always together, never color alone; one format (+5.4%, −12.2%).
- **Tickers:** always `$NAME`, uppercase, monospaced.
- **Numbers:** Aura Bucks to 2 decimals, shares up to 4, prices to 2.
- **Time:** the exchange's local time; relative under an hour ("4 min ago").
- **Countdowns:** one component for quotes, rumors, halts, votes and the market open.
- **Status chips:** one vocabulary shared by the API and the app: RUMOR, RULED, HALTED, VOIDED, OPEN, FILLED, CANCELED, LIQUIDATED.
- **Confirmations:** one slide-to-confirm for anything that moves money.
- **Errors:** one shape and one tone (see the API changes below).
- **Voice:** wire-style headlines on the tape and in pushes about stocks; plain words in settings, errors and anything about your cash.

### 3. The worst moments

In this app the worst moments aren't failed payments. They're getting roasted, getting liquidated and getting caught. Each one gets designed before the happy path.

| Moment | Weak version | Premium version |
| --- | --- | --- |
| Your stock crashes because friends filed on you | A push that says −18% | A heads-up during the rumor with a chance to respond; the headline and analyst note; your remaining super-injunctions; an appeal button; "comeback watch" coverage when a stock that fell 15% recovers |
| Margin call and liquidation | The position just disappears | A warning at 140% collateral showing the exact price that triggers liquidation; afterwards a receipt of what was sold, at what price, and what came back |
| SEC charge | Money silently gone | A case file: the trade, the profit, the odds you had, the fine, the headline, and how to stay clean next time |
| Market closed or stock halted | Greyed-out buttons | "Closed. Reopens 7:00 am. 3 events queued for the open" with an indicated price; halts show the vote and a countdown |
| Offline | Spinners, or old numbers that look live | Last prices stamped "Delayed · as of 9:41 pm," just like real market data; trade buttons say why they're off |
| Trade rejected | "Error 400" | "You're 230 short. Sell something or wait for Monday's stimulus check," with a button for each |
| Brand-new exchange | Empty lists | An IPO-day screen: invite friends, file the first event, see a sample headline |
| Wiped out | Stuck at zero | Chapter 7 offered right at the moment of the loss |

### What it changes in the API

- **One error shape** on every endpoint: `code`, `message`, `params` (the numbers the app fills into its copy), `retryable`, and `action` (the suggested next step). The app owns the final wording in one strings file.
- **Honest freshness:** every market payload carries `asOf` and `marketState` (pre, open, after, closed, halted).
- **Unsend:** a new event sits in a 30-second `SENDING` state and can be canceled.
- **One status everywhere:** events, halt votes, orders and SEC cases each have a status resource, a push and a socket update, all using the same enum.
- **Requotes show the difference:** a quote response includes the previous quote's price.
- **Liquidation price on every short**, computed by the server.
- **Idempotency keys on every write**, not just trades.

### How we check it

- Before every gate, break it on purpose: airplane mode mid-trade, a stale quote, a liquidation, an empty exchange, a halted stock, a closed market and a brutal roast. Every one must land on a designed screen.
- During the pilot, each tester uses the app for an hour like a normal member and notes every spot where it stops feeling like one product.

## Screens and states

The app is 32 screens, and each one gets designed in every state in the second column before it counts as done. Worst moments get drawn first: rumors and rulings about you, trade rejections, margin warnings, liquidation, closed / halted / offline, SEC charges and bankruptcy. Every one of them uses the Aura Exchange design system.

| # | Screen | States to design | Phase | Design |
| --- | --- | --- | --- | --- |
| 1 | Sign in | Sign in with Apple, email code, code expired, no network | 1 | Next |
| 2 | Join an exchange | Invite preview (who's listed), invite expired, exchange full | 1 | Next |
| 3 | Your IPO | Consent to be listed, pick a ticker, ticker taken, listed | 1 | Next |
| 4 | Create an exchange | Name, timezone and hours, invite friends, waiting for friends | 1 | Next |
| 5 | Home | Default, loading, brand-new exchange (IPO day), market closed, offline | 1 | Next |
| 6 | Market list | Sorted by change, halted rows, search results, no results | 1 | Next |
| 7 | Stock page | Default, your own stock, halted, closed with indicated price, rumor pending, delisted | 1 | Next |
| 8 | Stock overview | Default, no events yet | 1 | Next |
| 9 | Trade sheet | Buy, sell, short, cover, limit order (extended hours), stop-loss | 1 | Next |
| 10 | Order outcomes | Quote expiring, requote with the difference, rejected (cash, size, short cap), filled receipt, resting order | 1 | Next |
| 11 | File an event | Compose, pick subject, add receipts, self-filing note, daily limit hit, discard | 1 | Next |
| 12 | Your filing's status | Sending (30-second unsend), rumor live, ruled, halted for a vote, voided | 1 | Next |
| 13 | Rumor | Teaser, co-sign or cap, insider notice, countdown | 1 | Next |
| 14 | Rumor about you | Heads-up push, respond (no comment / deny) | 1 | Drawn |
| 15 | Ruling | Public view, up/down votes, conflicted voters, correction after an appeal | 1 | Next |
| 16 | Ruling on you | Loss, gain, queued for the open, story hidden | 1 | Drawn |
| 17 | News halt vote | Confirm / decline / reconsider, countdown, result | 1 | Next |
| 18 | Tape | All, filtered, empty, unread | 1 | Next |
| 19 | Notifications | List grouped by stock, quiet hours on | 1 | Next |
| 20 | Portfolio | Positions and cash, open orders, empty | 1 | Next |
| 21 | Margin warning | Banner and sheet with the liquidation price | 1 | Drawn |
| 22 | Liquidated | Receipt: what sold, at what price, what came back | 1 | Drawn |
| 23 | Closed, halted, offline | App-wide banners, trading disabled with reasons | 1 | Drawn |
| 24 | Server error, update required | Retry, update | 1 | Drawn |
| 25 | SEC charge | Case file, fine receipt | 2 | Drawn |
| 26 | Bankruptcy | Offer at the moment of the loss, Chapter 7 confirm, badge | 2 | Drawn |
| 27 | Earnings | Estimate entry, Sunday survey, results | 2 | Later |
| 28 | 13F reveal | Sunday top holders and shorts | 2 | Later |
| 29 | Leaderboards and awards | Season leaders, season-end awards | 2 | Later |
| 30 | You | Your listing, stats, super-injunctions left | 1 | Next |
| 31 | Settings | Notifications, quiet hours, opt out of being listed | 1 | Next |
| 32 | Admin | The Fed (rates), moderation queue, appeals | 1 | Later |

## Backend architecture

Keep the current stack (TypeScript, Fastify, PostgreSQL, a separate worker) and change four things for the iPhone app: many exchanges per server, token auth, a live socket, and cloud hosting.

### Components

| Component | Job | Built from |
| --- | --- | --- |
| iPhone app (Flutter) | The product | New, from `flutter-ios-template`; API client generated from the OpenAPI spec |
| Web client (React) | Admin console and a backup client | Existing web folder |
| API service | `/v1` REST endpoints, auth, validation, trades | Existing Fastify routes, versioned |
| Realtime gateway | WebSocket: price ticks and tape items per exchange | New, inside the API service, fed by Postgres LISTEN/NOTIFY |
| Engine worker | 15-second ticks, halts, liquidations, limit and stop orders, schedulers | Existing worker, generalized per exchange |
| Analyst worker | Rulings, headlines, rumor teasers, daily wraps, Fed statements | Existing judge, extended; provider-neutral |
| PostgreSQL | Source of truth, both ledgers | Existing schema plus migrations |
| Object storage | Receipts and avatars, uploaded with signed URLs | New; images still re-encoded with sharp |
| Push | Apple Push Notification service | New; device tokens per user |

### Key decisions

- **Multi-tenant.** Add `exchange_id` to every game table. A user is a global identity; a membership ties a user to an exchange and owns that exchange's listing and brokerage account. The current 1:1 user-to-stock link becomes 1:1 per exchange.
- **Auth.** Sign in with Apple, plus email codes as a fallback. Short-lived access tokens (15 minutes) and rotating refresh tokens, using the `jose` library already in the repo. Cookies and CSRF stay only for the web console. Joining an exchange is an invite link that opens the app.
- **Contract first.** The OpenAPI spec is the boundary. Start from `shared/openapi.yaml`, then generate it from the server's zod schemas; the app generates its Dart client from it, so the app and server can't drift.
- **Realtime.** The app subscribes to one channel per exchange it's viewing. Ticks are sent as compact deltas; the app polls as a fallback.
- **One engine leader.** The engine takes a Postgres advisory lock so only one worker ticks at a time, even if we run two for safety. One tick updates every listing in an exchange in a single transaction.
- **Data retention.** Raw ticks kept 7 days; 1-minute and 1-hour candles kept forever.
- **Money correctness.** Keep the immutable double-entry ledger, decimal math, idempotency keys and exact-reserve quotes. These are the parts that are hardest to get right and already are.
- **AI provider.** Keep the judge behind one interface with an API key (OpenAI or Anthropic). Drop the personal ChatGPT-login adapter.
- **Hosting.** Containers for the API and worker on a simple platform (Fly.io, Railway or Render), managed PostgreSQL, one US-East region to start. Replaces the home-PC Docker and Caddy setup.

## Data model and API

About half the current tables carry over with an `exchange_id` added; the rest are new for the price engine, rumors, the SEC, earnings and push.

### Tables

| Table | Change | Holds |
| --- | --- | --- |
| `exchanges` | New | Name, timezone, market hours, fee and rate settings, feature toggles |
| `memberships` | New | User ↔ exchange, role, consent and opt-out times |
| `listings` | From `person_stocks` | Ticker, fair-value base and hype, base and current volatility, last event time |
| `market_pools` | Changed | Reserves per listing; drop `organic_price` and `ambient_deviation` |
| `drift_queue` | New | News impact still to land: listing, event, remaining move, end time |
| `events` | From `aura_submissions` | Adds rumor end time, teaser, subject statement, self-filed flag |
| `event_receipts` | New | Storage key and type per attachment |
| `event_reactions` | New | Co-signs and caps |
| `rulings` | Changed | Adds headline, analyst note, category, final impact |
| `halts` | New | Stock or exchange-wide, reason, start, end |
| `orders` | From `limit_orders` | Adds stop-loss and take-profit types |
| `insider_windows`, `sec_cases` | New | Who was an insider when; investigations, fines, outcomes |
| `earnings_periods`, `earnings_estimates`, `earnings_ratings` | New | Weekly consensus, actuals, winners |
| `disclosures` | New | Weekly top-holder and top-short snapshots |
| `analyst_ratings` | New | Buy / Hold / Sell, price target, note |
| `corporate_actions` | New | Splits, reverse splits, bankruptcies, buybacks |
| `candles_1m`, `candles_1h` | New | Rolled up from raw ticks |
| `devices`, `notification_prefs`, `price_alerts` | New | Push tokens and settings |
| `reports`, `blocks` | New | App Store safety requirements |
| Ledgers, trades, quotes, seasons, votes, polls, glossary, audit | Kept | Plus `exchange_id` where needed |

### v1 API

All routes under `/v1`, bearer-token auth, cursor pagination, idempotency keys on anything that moves money.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/apple`, `POST /auth/email/start`, `POST /auth/email/verify`, `POST /auth/refresh`, `POST /auth/logout`, `GET /me` |
| Exchanges | `POST /exchanges`, `GET /exchanges`, `GET /exchanges/{id}`, `PATCH /exchanges/{id}/settings`, `POST /exchanges/{id}/invites`, `POST /invites/{code}/accept`, `POST /exchanges/{id}/fed` |
| Market data | `GET /exchanges/{id}/market`, `GET /listings/{id}`, `GET /listings/{id}/candles`, `GET /exchanges/{id}/index/candles`, `GET /listings/{id}/disclosures` |
| Trading | `POST /quotes`, `POST /trades`, `GET /portfolio`, `GET /orders`, `POST /orders`, `DELETE /orders/{id}`, `POST /positions/{id}/close` |
| Events | `POST /uploads` (signed URL), `POST /events`, `GET /events/{id}`, `POST /events/{id}/reactions`, `POST /events/{id}/statement`, `POST /events/{id}/votes`, `POST /halts/{id}/votes`, `POST /events/{id}/appeal`, `POST /events/{id}/injunction` |
| Tape and social | `GET /exchanges/{id}/tape`, `GET /listings/{id}/comments`, `POST /listings/{id}/comments`, `GET /exchanges/{id}/leaderboards` |
| Earnings | `GET /exchanges/{id}/earnings/current`, `POST /earnings/{id}/estimates`, `POST /earnings/{id}/ratings` |
| SEC | `GET /me/sec-cases`, `GET /exchanges/{id}/sec` |
| Devices and alerts | `POST /devices`, `PATCH /me/notification-prefs`, `POST /alerts`, `DELETE /alerts/{id}` |
| Moderation | `GET /exchanges/{id}/moderation/queue`, `POST /moderation/{id}/decision`, `POST /reports`, `POST /blocks` |
| Realtime | `GET /stream` (WebSocket; subscribe to an exchange for ticks and tape) |

## A day on the exchange

One made-up Tuesday for $JAKE shows every force at once: an overnight news gap, a short, a rumor rally, a ruling, mean reversion, and the SEC.

*(The doc had a chart of $JAKE's price through this day: ≈112.4 at the prior close, gap to ≈98.7 at 7:00, short pressure to ≈96.1, rumor rally to ≈99.2, ruling peak ≈104.6, fade to 101.9 at the close.)*

1. **2:14 am.** Someone files: Jake texted his ex "u up" and she replied "who is this." Eli and Mia co-sign with the screenshot. The Analyst rules a loss of 14; the co-signs push it to 18, so the stock is halted and the group votes 4–1 to confirm. The market is closed, so the hit waits.
2. **7:00 am.** Pre-market opens and the queued −12.2% lands as one gap (this time the random gap fraction was 0.9). Headline: `JAKE INDICATED SHARPLY LOWER AFTER OVERNIGHT 'WHO IS THIS' INCIDENT`. The rest drifts in by 7:45.
3. **9:05 am.** Nate shorts 60 shares. His own selling pushes the price from 98.9 to 96.1, so he averages about 97.5. Price is now sitting right on fair value.
4. **12:41 pm.** Sam files a rumor ("Jake spotted at the gym") with a photo. Mia isn't an insider, reads the teaser, and buys 50 shares; the price climbs to 99.2 before anyone knows the ruling. Sam, the author, quietly buys 30 at 97.
5. **12:51 pm.** The ruling lands at +10 (+5.4%): `JAKE SHARES RECOVER AS LONG-PROMISED GYM VISIT FINALLY MATERIALIZES`. Because the rumor buying had already moved the price, the stock overshoots fair value and peaks at 104.6.
6. **1:21 pm.** Sam's insider window closes and the SEC reviews his trade: about 210 profit, so a 27% chance of investigation. He's caught. Profit clawed back plus a 105 fine, and $SAM takes a SCANDAL hit: `SEC CHARGES SAM WITH TRADING ON NONPUBLIC GYM INFORMATION`.
7. **1:40 pm.** Mia sells the news at about 104 for a 5% gain. Mean reversion slowly pulls the price back toward fair value.
8. **10:00 pm.** Closing bell. $JAKE ends at 101.9. Nate's short is underwater by about 260 and he's holding it overnight, hoping for another 2 a.m.

## Roadmap and open questions

Build in four phases, each ending in a gate we have to pass before moving on. Phase 1 is the smallest version that's actually fun: events move prices, rumors are tradeable, and it's on everyone's phone.

| Phase | Name | Scope |
| --- | --- | --- |
| 0 | Fork and foundation | Fork the repo, add `exchange_id`; memberships and listings tables; token auth; `/v1` routes and OpenAPI spec; cloud deploy with managed Postgres; price-engine simulator |
| Gate 0 | | Simulator hits the 60/25/15 target; a test exchange runs in the cloud |
| 1 | MVP: the core loop | New price engine and tick loop; market hours, halts, breakers; rumor phase, co-signs, receipts; Analyst headlines and teasers; stop-loss and take-profit; tape and WebSocket stream; notifications (in-app inbox now, push later); app: market, stock, trade, file, tape, portfolio, onboarding |
| Gate 1 | | 5–8 friends play a full week on sideloaded builds; the break-it checklist passes |
| 2 | The good jokes | SEC and insider trading; Sunday 13F reveal; weekly earnings; analyst ratings and price targets; opening/closing bell wraps; splits and Chapter 11; super-injunctions, bankruptcy; season awards, career stats; report, block, moderation queue |
| Gate 2 | | One full 8-week season completed |
| 3 | Deep market | Options; 2× margin; buybacks and secondary offerings; funds; macro events; sector indices |

Phase 0 and the simulator come first because every number in this plan is a guess until we watch a fake season play out.

### Open questions to settle before we finalize

- [ ] **Who is it for?** Just your group, or can anyone create an exchange? That decides moderation load and App Store review.
- [ ] **Weekends:** markets open every day (proposed), or closed for a proper Monday gap?
- [ ] **Seasons:** reset prices to 100 every 8 weeks (proposed), or let them carry over?
- [ ] **Holdouts:** can a friend be listed without installing the app? Proposed no, consent required.
- [ ] **Self-trading:** keep the hard ban forever, or allow buybacks and offerings in Phase 3?
- [ ] **"CEO pay":** should you earn anything when your own stock does well, or stay fully separate?
- [ ] **Analyst tone:** how savage is the roast? Sets the AI prompt and the moderation rules.
- [ ] **AI budget:** roughly how many events a day per group? Sets the cost and which model we use.
- [ ] **Currency name:** Aura Bucks (proposed) or Aura Credits (current code)?
- [ ] **The fork:** confirm your friend is cool with us forking his repo, and whether he wants in.

Once these are answered, the next session is the feel of the app: screens, the ticker-tape look, sounds and haptics.
