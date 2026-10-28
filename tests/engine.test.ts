import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { spotPrice } from "../src/core/market.js";
import { applyNews, DEFAULT_ENGINE_PARAMS, fairValue, ipoListing, moveReserves, resolveReserves, tick, type EngineParams, type ListingState } from "../src/engine/engine.js";
import { followOnMove, impactOfMove, newsMove } from "../src/engine/news.js";
import { normal, seededRng, studentT } from "../src/engine/rng.js";

const HOUR = 3600;
const DAY = 24 * HOUR;
const quiet: EngineParams = { ...DEFAULT_ENGINE_PARAMS, baseDailyVol: 0 };
const still: EngineParams = { ...quiet, reversionHalfLifeDays: Infinity };
const price = (state: ListingState) => spotPrice(state).toNumber();
const fair = (state: ListingState) => fairValue(state).toNumber();

function freeze(state: ListingState): ListingState {
  state.drift.forEach((slice) => Object.freeze(slice));
  Object.freeze(state.drift);
  return Object.freeze(state);
}

describe("news curve m(d)", () => {
  it("matches the table in PLAN.md", () => {
    const table: Array<[number, string]> = [[3, "1.0"], [5, "2.0"], [10, "5.4"], [15, "9.5"], [20, "14.2"], [30, "25.0"]];
    for (const [impact, percent] of table) {
      expect((newsMove(impact) * 100).toFixed(1)).toBe(percent);
      expect((newsMove(-impact) * 100).toFixed(1)).toBe(`-${percent}`);
    }
    expect(newsMove(0)).toBe(0);
    expect(newsMove(45)).toBe(newsMove(30));
  });

  it("inverts, and follow-on moves compose to the new impact's move", () => {
    for (const impact of [-30, -12, -1, 4, 18, 30]) expect(impactOfMove(newsMove(impact))).toBeCloseTo(impact, 10);
    expect((1 + newsMove(12)) * (1 + followOnMove(12, 15))).toBeCloseTo(1 + newsMove(15), 12);
    expect(followOnMove(10, 10)).toBe(0);
  });
});

describe("seeded randomness", () => {
  it("replays the same sequence for the same seed", () => {
    const sequence = (seed: string) => { const rng = seededRng(seed); return Array.from({ length: 5 }, () => rng.next()); };
    expect(sequence("listing:1")).toEqual(sequence("listing:1"));
    expect(sequence("listing:1")).not.toEqual(sequence("listing:2"));
    expect(sequence("x").every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("draws unit-variance Student-t noise with fatter tails than a normal", () => {
    const rng = seededRng("tails");
    const draws = 200_000;
    let sumSquares = 0, tailT = 0, tailNormal = 0;
    for (let i = 0; i < draws; i++) {
      const t = studentT(rng, 4);
      sumSquares += t * t;
      if (Math.abs(t) > 3) tailT++;
      if (Math.abs(normal(rng)) > 3) tailNormal++;
    }
    expect(sumSquares / draws).toBeGreaterThan(0.93);
    expect(sumSquares / draws).toBeLessThan(1.07);
    expect(tailT / draws).toBeGreaterThan(2 * (tailNormal / draws));
  });
});

describe("price engine", () => {
  const ipo = () => ipoListing(4000, 400000);

  it("starts with fair value at the IPO price", () => {
    const state = ipo();
    expect(price(state)).toBe(100);
    expect(fair(state)).toBe(100);
  });

  it("re-solves reserves to a target price and keeps the constant product", () => {
    const next = resolveReserves(ipo(), "112.5");
    expect(spotPrice(next).toFixed(6)).toBe("112.500000");
    expect(next.shareReserve.mul(next.creditReserve).minus(1_600_000_000).abs().toNumber()).toBeLessThan(0.001);
    const moved = moveReserves(ipo(), Math.log(0.8));
    expect(spotPrice(moved).toFixed(6)).toBe("80.000000");
    expect(moved.shareReserve.mul(moved.creditReserve).minus(1_600_000_000).abs().toNumber()).toBeLessThan(0.001);
  });

  it("moves fair value the whole m(d) at once, half permanent and half hype", () => {
    const before = freeze(ipo());
    const { state, fairMove } = applyNews(before, [newsMove(20)], seededRng("news"));
    expect(fair(state) / fair(before)).toBeCloseTo(1 + newsMove(20), 12);
    expect(state.base.div(before.base).toNumber()).toBeCloseTo(Math.sqrt(1 + newsMove(20)), 12);
    expect(state.hype).toBeCloseTo(fairMove / 2, 12);
    expect(price(before)).toBe(100);
    expect(before.drift).toHaveLength(0);
  });

  it("gaps 40–120% of the move and drifts the rest in over 45 minutes", () => {
    const fractions: number[] = [];
    for (let seed = 0; seed < 200; seed++) {
      const { state, gap, fairMove } = applyNews(ipo(), [newsMove(-15)], seededRng(seed), still);
      fractions.push(gap / fairMove);
      if (seed > 3) continue;
      let after = state;
      for (let second = 0; second < 45 * 60; second += 15) after = tick(after, { elapsedSeconds: 15, tradingSeconds: 15 }, seededRng(second), still).state;
      expect(price(after)).toBeCloseTo(100 * (1 + newsMove(-15)), 4);
      expect(after.drift).toHaveLength(0);
    }
    expect(Math.min(...fractions)).toBeGreaterThanOrEqual(0.4);
    expect(Math.max(...fractions)).toBeLessThanOrEqual(1.2);
    expect(Math.min(...fractions)).toBeLessThan(0.45);
    expect(Math.max(...fractions)).toBeGreaterThan(1.15);
  });

  it("queues several rulings into one opening gap", () => {
    const together = applyNews(ipo(), [newsMove(10), newsMove(-5)], seededRng("open"));
    expect(Math.exp(together.fairMove)).toBeCloseTo((1 + newsMove(10)) * (1 + newsMove(-5)), 12);
    expect(together.state.drift).toHaveLength(1);
  });

  it("decays hype on a 3-day half-life and the volatility spike on a 2-hour one", () => {
    const { state } = applyNews(ipo(), [newsMove(30)], seededRng("spike"), still);
    expect(state.volBoost).toBeCloseTo(2, 12);
    const later = tick(state, { elapsedSeconds: 2 * HOUR, tradingSeconds: 0 }, seededRng(1), still).state;
    expect(later.volBoost).toBeCloseTo(1, 12);
    const days = tick(state, { elapsedSeconds: 3 * DAY, tradingSeconds: 0 }, seededRng(2), still).state;
    expect(days.hype).toBeCloseTo(state.hype / 2, 12);
    expect(applyNews(ipo(), [newsMove(10)], seededRng("small"), still).state.volBoost).toBeCloseTo(2 / 3, 12);
  });

  it("pulls price toward fair value on a 2-trading-day half-life, in any tick size", () => {
    const off = { ...ipo(), base: new Decimal(110) };
    const gapAfter = (state: ListingState) => Math.log(fair(state) / price(state));
    const oneStep = tick(off, { elapsedSeconds: 0, tradingSeconds: 2 * DEFAULT_ENGINE_PARAMS.tradingDaySeconds }, seededRng(0), quiet).state;
    expect(gapAfter(oneStep)).toBeCloseTo(Math.log(1.1) / 2, 6);
    let ticked: ListingState = off;
    for (let second = 0; second < 2 * DEFAULT_ENGINE_PARAMS.tradingDaySeconds; second += 15) {
      ticked = tick(ticked, { elapsedSeconds: 0, tradingSeconds: 15 }, seededRng(second), quiet).state;
    }
    expect(gapAfter(ticked)).toBeCloseTo(Math.log(1.1) / 2, 5);
  });

  it("scales noise to the 1.1% base daily vol times personality", () => {
    const rng = seededRng("noise");
    const state = ipoListing(4000, 400000, 1.5);
    const fixedFair = { ...DEFAULT_ENGINE_PARAMS, reversionHalfLifeDays: Infinity, quietDecay: null };
    let sumSquares = 0;
    const days = 20_000;
    for (let i = 0; i < days; i++) {
      const { move } = tick(state, { elapsedSeconds: 0, tradingSeconds: DEFAULT_ENGINE_PARAMS.tradingDaySeconds }, rng, fixedFair);
      sumSquares += move.noise ** 2;
    }
    expect(DEFAULT_ENGINE_PARAMS.baseDailyVol).toBe(0.011);
    expect(Math.sqrt(sumSquares / days)).toBeGreaterThan(0.011 * 1.5 * 0.95);
    expect(Math.sqrt(sumSquares / days)).toBeLessThan(0.011 * 1.5 * 1.05);
  });

  it("bleeds fair value 0.5% a day after 3 quiet days, capped at 5%, until the next ruling", () => {
    const step = (state: ListingState, seconds: number) => tick(state, { elapsedSeconds: seconds, tradingSeconds: 0 }, seededRng(seconds), still).state;
    const threeDays = step(ipo(), 3 * DAY);
    expect(threeDays.base.toNumber()).toBe(100);
    expect(step(threeDays, DAY).base.toNumber()).toBeCloseTo(99.5, 10);
    const capped = step(step(threeDays, DAY), 30 * DAY);
    expect(capped.base.toNumber()).toBeCloseTo(95, 10);
    const ruled = applyNews(capped, [newsMove(3)], seededRng("ruling"), still).state;
    expect(ruled.quietBleed).toBe(0);
    const lore = applyNews(step(threeDays, DAY), [newsMove(0)], seededRng("lore"), still);
    expect(lore.gap).toBe(0);
    expect(lore.state.quietSeconds).toBe(0);
    expect(lore.state.base.toNumber()).toBeCloseTo(99.5, 10);
    expect(step(ruled, 3 * DAY).base.eq(ruled.base)).toBe(true);
    expect(step(ipo(), 3 * DAY).base.toNumber()).toBe(100);
    expect(tick(ipo(), { elapsedSeconds: 10 * DAY, tradingSeconds: 0 }, seededRng(0), { ...still, quietDecay: null }).state.base.toNumber()).toBe(100);
  });

  it("is pure and replays exactly from the same seed", () => {
    const run = () => {
      const rng = seededRng("season");
      let state = freeze(ipoListing(4000, 400000, 1.2));
      for (let i = 0; i < 2000; i++) {
        if (i % 500 === 250) state = freeze(applyNews(state, [newsMove(i % 1000 === 250 ? 12 : -7)], rng).state);
        state = freeze(tick(state, { elapsedSeconds: 15, tradingSeconds: 15 }, rng).state);
      }
      return `${state.shareReserve.toFixed(8)}:${state.creditReserve.toFixed(8)}:${state.base.toFixed(8)}`;
    };
    expect(run()).toBe(run());
  });
});
