import { Decimal } from "decimal.js";
import { MAINTENANCE_COLLATERAL, quoteTrade, spotPrice, type MarketQuote } from "../../src/core/market.js";
import { DEFAULT_HOURS } from "../../src/core/market-hours.js";
import { applyNews, DEFAULT_ENGINE_PARAMS, fairValue, ipoListing, tick, type EngineParams, type ListingState } from "../../src/engine/engine.js";
import { followOnMove, MAX_IMPACT, newsMove } from "../../src/engine/news.js";
import { exponential, normal, seededRng, uniform, type Rng } from "../../src/engine/rng.js";
import type { TradeSide } from "../../src/types.js";

/**
 * A fake season for tuning the price engine (ROADMAP 0.6). Pure and seeded: the same config replays exactly.
 *
 * Every move of ln P is booked to one source: events (gaps, drift, and reversion toward a fair value that only
 * events move), trades (AMM fills), or noise. Reversion is split by how far each source has pushed the price away
 * from fair value, so a pump that fades is booked as trades both ways. See NOTES.md → Price-engine tuning.
 */

export interface EventConfig {
  /** Mean rulings per listing per day. Each listing's own rate is lognormal around it, with this sd of the log. */
  perListingPerDay: number;
  rateSpread: number;
  /** Share of rulings that are LORE (zero impact). */
  loreShare: number;
  /** Mean |d| the Analyst gives a non-LORE event (geometric, 1–30), before co-signs and caps. */
  meanAbsImpact: number;
  /** News-halt votes (|d| > 15): the share that decline (void) and that send the ruling back for a re-rule. */
  declineShare: number;
  reconsiderShare: number;
  /** Weekly earnings on Sundays at 8 pm: d = 6 × surprise, surprise ~ N(0, sd), clamped to ±18. */
  earnings: boolean;
  earningsSurpriseSd: number;
}

export interface TradingConfig {
  /** Casual trades per player per regular-session hour, sized a random fraction of equity, held `holdDays` on average. */
  casualPerHour: number;
  size: [number, number];
  holdDays: number;
  /** The share of casual new positions that are shorts. */
  shortShare: number;
  /** Per player and rumor in regular hours: the chance to trade it, and to guess its direction right. */
  rumorChance: number;
  rumorAccuracy: number;
  /** Per player and ruling in regular hours: the chance to chase it, at |d| = 10 (scaled by |d|/10, at most 1). */
  chaseChance: number;
  /** Per player per regular-session hour: the chance to trade one listing back toward the analysts' target (F). */
  valuePerHour: number;
  /** How far, as |ln(P/F)|, price must stray from the target before value traders act. */
  valueThreshold: number;
}

export interface SimConfig {
  seed: string | number;
  listings: number;
  weeks: number;
  tickSeconds: number;
  /** Shares in each pool at IPO, priced at 100 (so credits are 100 × shares). */
  poolShares: number;
  engine: EngineParams;
  events: EventConfig;
  trading: TradingConfig;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  seed: 1,
  listings: 8,
  weeks: 8,
  tickSeconds: 15,
  poolShares: 4000,
  engine: DEFAULT_ENGINE_PARAMS,
  events: {
    perListingPerDay: 1.5,
    rateSpread: 0.5,
    loreShare: 0.15,
    meanAbsImpact: 6,
    declineShare: 0.15,
    reconsiderShare: 0.15,
    earnings: true,
    earningsSurpriseSd: 0.6
  },
  trading: {
    casualPerHour: 0.4,
    size: [0.05, 0.2],
    holdDays: 1,
    shortShare: 0.25,
    rumorChance: 0.3,
    rumorAccuracy: 0.7,
    chaseChance: 0.3,
    valuePerHour: 0.1,
    valueThreshold: 0.06
  }
};

export interface Sources {
  events: number;
  trades: number;
  noise: number;
}

export interface DailyRow extends Sources {
  day: number;
  listing: string;
  close: number;
  fair: number;
}

export interface HourlyRow {
  hour: number;
  listing: string;
  price: number;
  fair: number;
}

export interface EventRow {
  at: number;
  listing: string;
  kind: "RULING" | "VOIDED" | "FOLLOW_ON" | "EARNINGS";
  impact: number;
  move: number;
  /** Delivered while closed and held for the opening gap. */
  queued: boolean;
}

export interface ListingSummary {
  ticker: string;
  personality: number;
  rulings: number;
  trades: number;
  finalPrice: number;
  seasonReturn: number;
  high: number;
  low: number;
  shares: Sources;
}

export interface SeasonResult {
  listings: ListingSummary[];
  /** Share of movement by source: Σ|Δ| of each source over hourly, daily and weekly windows, and daily Σ Δ². */
  shares: { hourly: Sources; daily: Sources; weekly: Sources; dailyVariance: Sources };
  /** The largest gap between ln(P/P0) and the booked sources, from rounding reserves to 8 dp. */
  residual: number;
  trades: { count: number; volume: number; liquidations: number };
  daily: DailyRow[];
  hourly: HourlyRow[];
  events: EventRow[];
}

const HOUR = 3600;
const DAY = 24 * HOUR;
const TICKERS = ["$NATE", "$JAKE", "$MIA", "$ELI", "$SAM", "$ZOE", "$LEO", "$AVA", "$KAI", "$IVY", "$MAX", "$UMA"];
/** How active the group is by local hour, 0–23: quiet overnight, busiest in the evening. */
const ACTIVITY = [0.8, 0.6, 0.25, 0.1, 0.1, 0.1, 0.15, 0.4, 0.5, 0.6, 0.6, 0.6, 0.7, 0.7, 0.7, 0.8, 0.9, 1, 1, 1, 1, 1, 1, 0.9];
const MEAN_ACTIVITY = ACTIVITY.reduce((sum, value) => sum + value, 0) / ACTIVITY.length;
const SHORT_MARGIN = new Decimal("0.5");
const SHORT_CAP_PER_STOCK = new Decimal("0.20");
const SHORT_CAP_TOTAL = new Decimal("0.50");
const FEE = new Decimal("0.005");

interface Listing {
  index: number;
  ticker: string;
  state: ListingState;
  /** This listing's own noise stream. */
  noise: Rng;
  eventRate: number;
  haltedUntil: number;
  lastTickAt: number;
  queued: number[];
  booked: Sources;
  lastDaily: Sources;
  lastHourly: Sources;
  rulingsOn: Map<number, number>;
  rulings: number;
  trades: number;
  high: number;
  low: number;
}

interface Position {
  long: Decimal;
  short: Decimal;
  escrow: Decimal;
}

interface Player {
  index: number;
  cash: Decimal;
  positions: Position[];
}

/** A time-ordered agenda; ties run in the order they were added. */
class Agenda {
  private heap: Array<{ at: number; seq: number; run: () => void }> = [];
  private seq = 0;

  add(at: number, run: () => void): void {
    const heap = this.heap;
    heap.push({ at, seq: this.seq++, run });
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
      i = parent;
    }
  }

  runUntil(time: number): void {
    while (this.heap.length > 0 && this.heap[0]!.at <= time) {
      const top = this.heap[0]!;
      const last = this.heap.pop()!;
      if (this.heap.length > 0) {
        this.heap[0] = last;
        let i = 0;
        for (;;) {
          const left = 2 * i + 1, right = left + 1;
          let smallest = i;
          if (left < this.heap.length && this.before(left, smallest)) smallest = left;
          if (right < this.heap.length && this.before(right, smallest)) smallest = right;
          if (smallest === i) break;
          [this.heap[i], this.heap[smallest]] = [this.heap[smallest]!, this.heap[i]!];
          i = smallest;
        }
      }
      top.run();
    }
  }

  private before(a: number, b: number): boolean {
    const x = this.heap[a]!, y = this.heap[b]!;
    return x.at < y.at || (x.at === y.at && x.seq < y.seq);
  }
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const zero = (): Sources => ({ events: 0, trades: 0, noise: 0 });
const minus = (a: Sources, b: Sources): Sources => ({ events: a.events - b.events, trades: a.trades - b.trades, noise: a.noise - b.noise });

/** Σ|Δ| (or Σ Δ²) of each source, as shares of the total. */
export function sourceShares(deltas: Sources[], power = 1): Sources {
  const total = zero();
  for (const delta of deltas) {
    total.events += Math.abs(delta.events) ** power;
    total.trades += Math.abs(delta.trades) ** power;
    total.noise += Math.abs(delta.noise) ** power;
  }
  const sum = total.events + total.trades + total.noise || 1;
  return { events: total.events / sum, trades: total.trades / sum, noise: total.noise / sum };
}

export function runSeason(config: SimConfig): SeasonResult {
  // Separate random streams, so changing how players trade changes neither the events nor the noise path.
  const eventRng: Rng = seededRng(`${config.seed}:events`);
  const tradeRng: Rng = seededRng(`${config.seed}:trades`);
  const { events: ev, trading: tr, tickSeconds } = config;

  // t = 0 is Monday's pre-open; each simulated day runs pre-open to pre-open in the exchange's local time.
  const preOpenMinutes = minutesOf(DEFAULT_HOURS.preOpen);
  const sinceOpen = (hhmm: string) => ((minutesOf(hhmm) - preOpenMinutes + 24 * 60) % (24 * 60)) * 60;
  const openAt = sinceOpen(DEFAULT_HOURS.open);
  const closeAt = sinceOpen(DEFAULT_HOURS.close);
  const afterCloseAt = sinceOpen(DEFAULT_HOURS.afterClose) || DAY;
  const engine: EngineParams = { ...config.engine, tradingDaySeconds: afterCloseAt };
  const reversionStep = 1 - Math.exp((-Math.LN2 / engine.reversionHalfLifeDays) * (tickSeconds / engine.tradingDaySeconds));
  const end = config.weeks * 7 * DAY;
  const session = (t: number) => {
    const s = t % DAY;
    return s < openAt ? "PRE" : s < closeAt ? "OPEN" : s < afterCloseAt ? "AFTER" : "CLOSED";
  };
  const localHour = (t: number) => Math.floor(preOpenMinutes / 60 + t / HOUR) % 24;
  const localDay = (t: number) => Math.floor((t + preOpenMinutes * 60) / DAY);
  const nextOpen = (t: number) => (t % DAY < openAt ? t - (t % DAY) + openAt : t - (t % DAY) + DAY + openAt);

  const agenda = new Agenda();
  const result: Pick<SeasonResult, "daily" | "hourly" | "events"> = { daily: [], hourly: [], events: [] };
  const counts = { count: 0, volume: new Decimal(0), liquidations: 0 };

  const rates = Array.from({ length: config.listings }, () => ev.perListingPerDay * Math.exp(ev.rateSpread * normal(eventRng) - (ev.rateSpread ** 2) / 2));
  const listings: Listing[] = rates.map((rate, index) => {
    const personality = Math.min(2, Math.max(0.5, rate / ev.perListingPerDay));
    return {
      index, ticker: TICKERS[index] ?? `$L${String.fromCharCode(65 + index)}X`, state: ipoListing(config.poolShares, config.poolShares * 100, personality), noise: seededRng(`${config.seed}:noise:${index}`), eventRate: rate,
      haltedUntil: 0, lastTickAt: 0, queued: [], booked: zero(), lastDaily: zero(), lastHourly: zero(), rulingsOn: new Map(),
      rulings: 0, trades: 0, high: 100, low: 100
    };
  });
  const lnFair0 = Math.log(100);
  const players: Player[] = listings.map((_, index) => ({
    index, cash: new Decimal(10000), positions: listings.map(() => ({ long: new Decimal(0), short: new Decimal(0), escrow: new Decimal(0) }))
  }));
  let now = 0;

  const price = (listing: Listing) => spotPrice(listing.state);
  const halted = (listing: Listing) => listing.haltedUntil > now;
  const pick = <T>(items: T[]) => items[Math.floor(tradeRng.next() * items.length)]!;
  const equity = (player: Player) => player.positions.reduce((sum, position, i) => {
    const p = price(listings[i]!);
    return sum.plus(position.long.mul(p)).plus(position.escrow).minus(position.short.mul(p));
  }, player.cash);
  const shortExposure = (player: Player) => player.positions.reduce((sum, position, i) => sum.plus(position.short.mul(price(listings[i]!))), new Decimal(0));

  /** A market order through the real AMM quote. Returns the shares filled (0 if refused). */
  function execute(player: Player, listing: Listing, side: TradeSide, wanted: Decimal): Decimal {
    if (session(now) !== "OPEN" || halted(listing) || listing.index === player.index) return new Decimal(0);
    const position = player.positions[listing.index]!;
    const p = price(listing);
    let quantity = Decimal.min(wanted, listing.state.shareReserve.mul("0.0999"));
    if (side === "SELL") quantity = Decimal.min(quantity, position.long);
    if (side === "COVER") quantity = Decimal.min(quantity, position.short);
    if (side === "SHORT") {
      if (position.long.gt(0)) return new Decimal(0);
      const worth = equity(player);
      const room = Decimal.min(worth.mul(SHORT_CAP_PER_STOCK).minus(position.short.mul(p)), worth.mul(SHORT_CAP_TOTAL).minus(shortExposure(player)));
      quantity = Decimal.min(quantity, room.div(p), player.cash.div(p.mul(SHORT_MARGIN)));
    }
    if (side === "BUY") {
      if (position.short.gt(0)) return new Decimal(0);
      quantity = Decimal.min(quantity, player.cash.div(p.mul("1.02")));
    }
    quantity = quantity.toDecimalPlaces(4, Decimal.ROUND_DOWN);
    if (quantity.lt("0.01")) return new Decimal(0);
    const quote: MarketQuote = quoteTrade(listing.state, side, quantity, FEE);
    const net = new Decimal(quote.netAmount), gross = new Decimal(quote.grossAmount);
    if (side === "BUY") {
      if (net.gt(player.cash)) return new Decimal(0);
      player.cash = player.cash.minus(net);
      position.long = position.long.plus(quantity);
    } else if (side === "SELL") {
      player.cash = player.cash.plus(net);
      position.long = position.long.minus(quantity);
    } else if (side === "SHORT") {
      const margin = gross.mul(SHORT_MARGIN);
      player.cash = player.cash.minus(margin);
      position.escrow = position.escrow.plus(net).plus(margin);
      position.short = position.short.plus(quantity);
    } else {
      const released = position.escrow.mul(quantity.div(position.short));
      position.escrow = position.escrow.minus(released);
      position.short = position.short.minus(quantity);
      player.cash = player.cash.plus(released).minus(net);
    }
    const before = p.toNumber();
    listing.state = { ...listing.state, shareReserve: new Decimal(quote.nextShareReserve), creditReserve: new Decimal(quote.nextCreditReserve) };
    listing.booked.trades += Math.log(price(listing).toNumber() / before);
    listing.trades++;
    counts.count++;
    counts.volume = counts.volume.plus(gross);
    return quantity;
  }

  /** Opens a position worth `fraction` of equity and closes it after `holdSeconds` (at the next open if closed by then). */
  function open(player: Player, listing: Listing, side: "BUY" | "SHORT", fraction: number, holdSeconds: number): void {
    const filled = execute(player, listing, side, equity(player).mul(fraction).div(price(listing)));
    if (filled.lte(0)) return;
    const close = () => {
      if (session(now) !== "OPEN" || halted(listing)) {
        agenda.add(nextOpen(now + 1) + uniform(tradeRng, 0, HOUR), close);
        return;
      }
      execute(player, listing, side === "BUY" ? "SELL" : "COVER", filled);
    };
    agenda.add(now + holdSeconds, close);
  }

  const others = (player: Player) => listings.filter((listing) => listing.index !== player.index);
  const size = (scale = 1) => uniform(tradeRng, tr.size[0], tr.size[1]) * scale;

  /** Delivers a fair-value move now, or holds it for the opening gap while the market is closed. */
  function deliver(listing: Listing, move: number, row: Omit<EventRow, "at" | "listing" | "move" | "queued">): void {
    const queued = session(now) === "CLOSED";
    result.events.push({ at: now, listing: listing.ticker, move, queued, ...row });
    if (queued) {
      listing.queued.push(move);
      return;
    }
    const { state, gap } = applyNews(listing.state, [move], eventRng, engine);
    listing.state = state;
    listing.booked.events += gap;
  }

  function rule(listing: Listing, impact: number): void {
    listing.rulings++;
    deliver(listing, newsMove(impact), { kind: "RULING", impact });
    if (impact === 0) return;
    if (session(now) === "OPEN") {
      for (const player of players) {
        if (player.index === listing.index || tradeRng.next() >= tr.chaseChance * Math.min(1, Math.abs(impact) / 10)) continue;
        agenda.add(now + uniform(tradeRng, 60, 20 * 60), () => open(player, listing, impact > 0 ? "BUY" : "SHORT", size(Math.min(1.5, Math.abs(impact) / 10)), exponential(tradeRng, 1 / (6 * HOUR))));
      }
    }
    // Up/down votes for 2 hours, ±10% of the original impact per net vote, capped at ±50%.
    const votes = Math.max(-5, Math.min(5, Math.round(normal(eventRng) * 2 + 0.3)));
    if (votes !== 0) {
      agenda.add(now + 2 * HOUR, () => deliver(listing, followOnMove(impact, impact * (1 + 0.1 * votes)), { kind: "FOLLOW_ON", impact: impact * 0.1 * votes }));
    }
  }

  function file(listing: Listing): void {
    const day = localDay(now);
    const pileOn = (listing.rulingsOn.get(day) ?? 0) >= 5 ? 0.5 : 1;
    listing.rulingsOn.set(day, (listing.rulingsOn.get(day) ?? 0) + 1);
    const lore = eventRng.next() < ev.loreShare;
    const magnitude = Math.min(MAX_IMPACT, 1 + Math.floor(Math.log(1 - eventRng.next()) / Math.log(1 - 1 / ev.meanAbsImpact)));
    const cosigns = Math.min(3, poisson(0.8)), caps = Math.min(3, poisson(0.4));
    const impact = lore ? 0 : Math.round((eventRng.next() < 0.5 ? -1 : 1) * magnitude * (1 + 0.1 * (cosigns - caps)) * pileOn);
    const rumorAt = now + 30, rulingAt = rumorAt + 10 * 60;
    if (session(rumorAt) === "OPEN") {
      const truth = impact === 0 ? (tradeRng.next() < 0.5 ? 1 : -1) : Math.sign(impact);
      for (const player of players) {
        if (player.index === listing.index || tradeRng.next() >= tr.rumorChance) continue;
        const direction = tradeRng.next() < tr.rumorAccuracy ? truth : -truth;
        const fraction = size(Math.max(0.3, Math.min(1.5, Math.abs(impact) / 10)));
        agenda.add(rumorAt + uniform(tradeRng, 0, 9.5 * 60), () => open(player, listing, direction > 0 ? "BUY" : "SHORT", fraction, rulingAt + uniform(tradeRng, 5 * 60, 90 * 60) - now));
      }
    }
    agenda.add(rulingAt, () => {
      if (Math.abs(impact) <= 15) return rule(listing, impact);
      // A news halt while the group votes: Confirm, Decline (void) or Reconsider (a final re-rule).
      listing.haltedUntil = now + 30 * 60;
      agenda.add(listing.haltedUntil, () => {
        const vote = eventRng.next();
        if (vote < ev.declineShare) {
          result.events.push({ at: now, listing: listing.ticker, kind: "VOIDED", impact, move: 0, queued: false });
          return;
        }
        rule(listing, vote < ev.declineShare + ev.reconsiderShare ? Math.round(impact * uniform(eventRng, 0.5, 1.2)) : impact);
      });
    });
  }

  function poisson(mean: number): number {
    let k = 0, p = Math.exp(-mean), sum = p;
    const u = eventRng.next();
    while (u > sum) { k++; p *= mean / k; sum += p; }
    return k;
  }

  // Filings arrive as a Poisson process per listing, thinned by the hour-of-day activity profile.
  for (const listing of listings) {
    const peakRate = listing.eventRate / DAY / MEAN_ACTIVITY;
    const next = () => {
      if (eventRng.next() < ACTIVITY[localHour(now)]!) file(listing);
      agenda.add(now + exponential(eventRng, peakRate), next);
    };
    agenda.add(exponential(eventRng, peakRate), next);
  }

  for (let week = 0; week < config.weeks; week++) {
    // Mondays 9 am: the allowance. Sundays 8 pm (after hours): earnings.
    agenda.add(week * 7 * DAY + openAt, () => players.forEach((player) => { player.cash = player.cash.plus(1000); }));
    if (ev.earnings) {
      agenda.add(week * 7 * DAY + 6 * DAY + sinceOpen("20:00"), () => {
        for (const listing of listings) {
          const impact = Math.round(Math.max(-18, Math.min(18, 6 * normal(eventRng) * ev.earningsSurpriseSd)) * 10) / 10;
          deliver(listing, newsMove(impact), { kind: "EARNINGS", impact });
        }
      });
    }
  }

  for (const player of players) {
    const casual = () => {
      if (session(now) === "OPEN") {
        const listing = pick(others(player));
        const position = player.positions[listing.index]!;
        if (position.long.gt(0) && tradeRng.next() < 0.5) execute(player, listing, "SELL", position.long);
        else if (position.short.gt(0) && tradeRng.next() < 0.5) execute(player, listing, "COVER", position.short);
        else {
          const side = position.long.gt(0) ? "BUY" : position.short.gt(0) || tradeRng.next() < tr.shortShare ? "SHORT" : "BUY";
          open(player, listing, side, size(), exponential(tradeRng, 1 / (tr.holdDays * DAY)));
        }
      }
      agenda.add(now + exponential(tradeRng, tr.casualPerHour / HOUR), casual);
    };
    agenda.add(exponential(tradeRng, tr.casualPerHour / HOUR), casual);

    const value = () => {
      if (session(now) === "OPEN") {
        const listing = pick(others(player));
        const position = player.positions[listing.index]!;
        const off = Math.log(price(listing).div(fairValue(listing.state)).toNumber());
        if (off > tr.valueThreshold) {
          if (position.long.gt(0)) execute(player, listing, "SELL", position.long);
          else open(player, listing, "SHORT", size(), uniform(tradeRng, 0.5, 2) * DAY);
        } else if (off < -tr.valueThreshold) {
          if (position.short.gt(0)) execute(player, listing, "COVER", position.short);
          else open(player, listing, "BUY", size(), uniform(tradeRng, 0.5, 2) * DAY);
        }
      }
      agenda.add(now + exponential(tradeRng, tr.valuePerHour / HOUR), value);
    };
    agenda.add(exponential(tradeRng, tr.valuePerHour / HOUR), value);
  }

  // Margin: shorts under 125% collateral are bought back by force.
  const liquidate = () => {
    for (const player of players) {
      player.positions.forEach((position, i) => {
        const listing = listings[i]!;
        if (position.short.lte(0) || position.escrow.gte(position.short.mul(price(listing)).mul(MAINTENANCE_COLLATERAL))) return;
        if (execute(player, listing, "COVER", position.short).gt(0)) counts.liquidations++;
      });
    }
    agenda.add(now + 5 * 60, liquidate);
  };
  agenda.add(openAt, liquidate);

  let previous = "CLOSED";
  let residual = 0;
  const hourlyDeltas: Sources[] = [];
  for (now = 0; now < end; now += tickSeconds) {
    agenda.runUntil(now);
    const state = session(now);
    if (previous === "CLOSED" && state !== "CLOSED") {
      for (const listing of listings) {
        if (listing.queued.length === 0) continue;
        const { state: next, gap } = applyNews(listing.state, listing.queued, eventRng, engine);
        listing.state = next;
        listing.booked.events += gap;
        listing.queued = [];
      }
    }
    if (state !== "CLOSED") {
      for (const listing of listings) {
        if (halted(listing)) continue;
        const { state: next, move } = tick(listing.state, { elapsedSeconds: now - listing.lastTickAt, tradingSeconds: tickSeconds }, listing.noise, engine);
        listing.state = next;
        listing.lastTickAt = now;
        const b = listing.booked;
        const lnFair = Math.log(next.base.toNumber()) + next.hype;
        const eventsOff = b.events - (lnFair - lnFair0);
        b.events += move.drift - reversionStep * eventsOff;
        b.trades -= reversionStep * b.trades;
        b.noise += move.noise - reversionStep * b.noise;
      }
    }
    if (now % HOUR === 0) {
      for (const listing of listings) {
        const p = price(listing).toNumber();
        listing.high = Math.max(listing.high, p);
        listing.low = Math.min(listing.low, p);
        result.hourly.push({ hour: now / HOUR, listing: listing.ticker, price: p, fair: fairValue(listing.state).toNumber() });
        hourlyDeltas.push(minus(listing.booked, listing.lastHourly));
        listing.lastHourly = { ...listing.booked };
        residual = Math.max(residual, Math.abs(Math.log(p / 100) - (listing.booked.events + listing.booked.trades + listing.booked.noise)));
      }
    }
    if (previous !== "CLOSED" && state === "CLOSED") {
      for (const listing of listings) {
        result.daily.push({
          day: Math.floor(now / DAY), listing: listing.ticker, close: price(listing).toNumber(), fair: fairValue(listing.state).toNumber(),
          ...minus(listing.booked, listing.lastDaily)
        });
        listing.lastDaily = { ...listing.booked };
      }
    }
    previous = state;
  }

  return { ...summarize(listings, result, hourlyDeltas, residual), trades: { count: counts.count, volume: counts.volume.toNumber(), liquidations: counts.liquidations }, ...result };
}

function summarize(listings: Listing[], result: Pick<SeasonResult, "daily" | "hourly" | "events">, hourlyDeltas: Sources[], residual: number): Pick<SeasonResult, "listings" | "shares" | "residual"> {
  const weekly: Sources[] = [];
  for (const listing of listings) {
    const days = result.daily.filter((row) => row.listing === listing.ticker);
    for (let start = 0; start < days.length; start += 7) {
      weekly.push(days.slice(start, start + 7).reduce((sum, row) => ({ events: sum.events + row.events, trades: sum.trades + row.trades, noise: sum.noise + row.noise }), zero()));
    }
  }
  return {
    listings: listings.map((listing) => {
      const finalPrice = spotPrice(listing.state).toNumber();
      return {
        ticker: listing.ticker, personality: listing.state.personality, rulings: listing.rulings, trades: listing.trades,
        finalPrice, seasonReturn: finalPrice / 100 - 1, high: listing.high, low: listing.low,
        shares: sourceShares(result.daily.filter((row) => row.listing === listing.ticker))
      };
    }),
    shares: { hourly: sourceShares(hourlyDeltas), daily: sourceShares(result.daily), weekly: sourceShares(weekly), dailyVariance: sourceShares(result.daily, 2) },
    residual
  };
}
