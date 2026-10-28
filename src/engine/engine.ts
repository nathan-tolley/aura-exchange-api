import { Decimal } from "decimal.js";
import { spotPrice, type MarketState } from "../core/market.js";
import { impactOfMove, MAX_IMPACT } from "./news.js";
import { studentT, uniform, type Rng } from "./rng.js";

/**
 * The price engine (PLAN.md → The price engine). Pure: state and an injected Rng in, new state out, no I/O.
 *
 * Priced values (reserves, the base B) are Decimal. The model's dimensionless ratios (log moves, ln H, the
 * volatility boost, drift) are numbers; a ratio is applied to a Decimal price and the reserves are rounded to 8 dp.
 */

export interface EngineParams {
  /** Open-market seconds in one trading day: PRE + OPEN + AFTER (19 h with the default hours). */
  tradingDaySeconds: number;
  /** Mean reversion half-life, in trading days. */
  reversionHalfLifeDays: number;
  /** Hype half-life, in wall-clock seconds. */
  hypeHalfLifeSeconds: number;
  /** The share of a news move that goes into the permanent base B; the rest is hype. */
  baseShare: number;
  /** The instant gap is a random fraction of the move, between these. */
  gapMin: number;
  gapMax: number;
  /** The rest of the move drifts in over this many open-market seconds. */
  driftSeconds: number;
  /** Base daily volatility, before personality and news spikes. */
  baseDailyVol: number;
  /** Degrees of freedom of the Student-t noise. */
  noiseDf: number;
  /** Volatility multiplier right after a ±30 move; smaller moves spike proportionally less. */
  volSpikeMax: number;
  /** Half-life of the volatility spike, in wall-clock seconds. */
  volHalfLifeSeconds: number;
  /** After `afterSeconds` without a ruling, B bleeds `perDay` a day, at most `cap` in all. Null turns it off. */
  quietDecay: { afterSeconds: number; perDay: number; cap: number } | null;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

export const DEFAULT_ENGINE_PARAMS: EngineParams = {
  tradingDaySeconds: 19 * HOUR,
  reversionHalfLifeDays: 2,
  hypeHalfLifeSeconds: 3 * DAY,
  baseShare: 0.5,
  gapMin: 0.4,
  gapMax: 1.2,
  driftSeconds: 45 * 60,
  // The plan said 2%; 1.1% lands the simulator near 60/25/15 (DECISIONS.md open question 12, agreed 2026-10-28).
  baseDailyVol: 0.011,
  noiseDf: 4,
  volSpikeMax: 3,
  volHalfLifeSeconds: 2 * HOUR,
  quietDecay: { afterSeconds: 3 * DAY, perDay: 0.005, cap: 0.05 }
};

/** News that hasn't reached the price yet: a log move released evenly over open-market time. */
export interface DriftSlice {
  remaining: number;
  secondsLeft: number;
}

export interface ListingState {
  shareReserve: Decimal;
  creditReserve: Decimal;
  /** B, the permanent part of fair value. */
  base: Decimal;
  /** ln H, the hype part of fair value; decays to 0. */
  hype: number;
  /** The volatility multiplier minus 1 after news; decays to 0. */
  volBoost: number;
  /** 0.5–2.0: how jumpy this listing is. */
  personality: number;
  drift: DriftSlice[];
  /** Wall-clock seconds since a ruling last moved fair value. */
  quietSeconds: number;
  /** The log of the quiet decay applied to B since then (≤ 0). */
  quietBleed: number;
}

/** A tick's price move in log terms, by force. Trades between ticks are not in here: they move the reserves directly. */
export interface TickMove {
  reversion: number;
  drift: number;
  noise: number;
}

export interface TickInput {
  /** Wall-clock seconds since the previous tick. Hype, the volatility spike and quiet decay run on these. */
  elapsedSeconds: number;
  /** Open-market seconds this tick covers, normally the 15 s tick. Reversion, drift and noise run on these. */
  tradingSeconds: number;
}

const decay = (seconds: number, halfLife: number) => 0.5 ** (seconds / halfLife);
const reserveDp = (value: Decimal) => value.toDecimalPlaces(8, Decimal.ROUND_HALF_UP);

/** A fresh listing whose fair value equals its IPO price. */
export function ipoListing(shares: Decimal.Value, credits: Decimal.Value, personality = 1): ListingState {
  const state = { shareReserve: new Decimal(shares), creditReserve: new Decimal(credits) };
  return { ...state, base: spotPrice(state), hype: 0, volBoost: 0, personality, drift: [], quietSeconds: 0, quietBleed: 0 };
}

/** F = B × H. */
export function fairValue(state: ListingState): Decimal {
  return state.base.mul(Math.exp(state.hype));
}

/** Moves the pool to `target` price, keeping its constant product (as the ambient-motion job does). */
export function resolveReserves(state: MarketState, target: Decimal.Value): { shareReserve: Decimal; creditReserve: Decimal } {
  const invariant = new Decimal(state.shareReserve).mul(state.creditReserve);
  return { shareReserve: reserveDp(invariant.div(target).sqrt()), creditReserve: reserveDp(invariant.mul(target).sqrt()) };
}

/** Multiplies the pool's price by e^logMove, keeping its constant product: shares ÷ s and credits × s with s = e^(logMove/2). */
export function moveReserves(state: MarketState, logMove: number): { shareReserve: Decimal; creditReserve: Decimal } {
  const s = Math.exp(logMove / 2);
  return { shareReserve: reserveDp(new Decimal(state.shareReserve).div(s)), creditReserve: reserveDp(new Decimal(state.creditReserve).mul(s)) };
}

function quietDecay(state: ListingState, elapsedSeconds: number, params: EngineParams): Pick<ListingState, "base" | "quietSeconds" | "quietBleed"> {
  const quietSeconds = state.quietSeconds + elapsedSeconds;
  const rule = params.quietDecay;
  if (!rule) return { base: state.base, quietSeconds, quietBleed: state.quietBleed };
  const bleedingSeconds = Math.max(0, quietSeconds - rule.afterSeconds) - Math.max(0, state.quietSeconds - rule.afterSeconds);
  const floor = Math.log(1 - rule.cap);
  const quietBleed = Math.max(floor, state.quietBleed + Math.log(1 - rule.perDay) * (bleedingSeconds / DAY));
  const step = quietBleed - state.quietBleed;
  return { base: step === 0 ? state.base : state.base.mul(Math.exp(step)), quietSeconds, quietBleed };
}

/**
 * One tick: ln P += reversion toward F + this tick's drift + Student-t noise; then the reserves move to the new
 * price. Reversion uses the exact discrete step, (1 − e^(−κΔt))·ln(F/P), so a long tick can't overshoot.
 */
export function tick(state: ListingState, input: TickInput, rng: Rng, params: EngineParams = DEFAULT_ENGINE_PARAMS): { state: ListingState; move: TickMove } {
  const { elapsedSeconds, tradingSeconds } = input;
  const hype = state.hype * decay(elapsedSeconds, params.hypeHalfLifeSeconds);
  const volBoost = state.volBoost * decay(elapsedSeconds, params.volHalfLifeSeconds);
  const quiet = quietDecay(state, elapsedSeconds, params);

  const dt = tradingSeconds / params.tradingDaySeconds;
  const logFairOverPrice = Math.log(quiet.base.div(spotPrice(state)).toNumber()) + hype;
  const reversion = (1 - Math.exp((-Math.LN2 / params.reversionHalfLifeDays) * dt)) * logFairOverPrice;

  let drift = 0;
  const slices: DriftSlice[] = [];
  for (const slice of state.drift) {
    const share = Math.min(1, tradingSeconds / slice.secondsLeft);
    drift += slice.remaining * share;
    if (share < 1) slices.push({ remaining: slice.remaining * (1 - share), secondsLeft: slice.secondsLeft - tradingSeconds });
  }

  const sigma = params.baseDailyVol * state.personality * (1 + volBoost);
  const noise = sigma * Math.sqrt(dt) * studentT(rng, params.noiseDf);
  const reserves = moveReserves(state, reversion + drift + noise);
  return { state: { ...state, ...reserves, ...quiet, hype, volBoost, drift: slices }, move: { reversion, drift, noise } };
}

/**
 * Final rulings hit the listing. `moves` are fair-value moves as fractions: newsMove(d) for a ruling, followOnMove()
 * for a vote or appeal change. Several rulings queued while the market was closed are passed together and land as
 * one opening gap. A ruling with no move (LORE) still restarts the quiet-decay clock.
 *
 * F moves the whole combined move at once, split in log terms between B and the hype. The price gaps a random
 * 40–120% of it now and drifts the rest in over 45 minutes; volatility spikes up to 3× for a ±30-sized move.
 * `gap` and `fairMove` are log moves.
 */
export function applyNews(state: ListingState, moves: number[], rng: Rng, params: EngineParams = DEFAULT_ENGINE_PARAMS): { state: ListingState; gap: number; fairMove: number } {
  const fairMove = moves.reduce((sum, move) => sum + Math.log1p(move), 0);
  if (fairMove === 0) return { state: { ...state, quietSeconds: 0, quietBleed: 0 }, gap: 0, fairMove };
  const baseMove = fairMove * params.baseShare;
  const gap = uniform(rng, params.gapMin, params.gapMax) * fairMove;
  const size = Math.abs(impactOfMove(Math.expm1(fairMove))) / MAX_IMPACT;
  const reserves = moveReserves(state, gap);
  return {
    state: {
      ...state,
      ...reserves,
      base: state.base.mul(Math.exp(baseMove)),
      hype: state.hype + fairMove - baseMove,
      volBoost: Math.max(state.volBoost, (params.volSpikeMax - 1) * size),
      drift: [...state.drift, { remaining: fairMove - gap, secondsLeft: params.driftSeconds }],
      quietSeconds: 0,
      quietBleed: 0
    },
    gap,
    fairMove
  };
}
