import { describe, expect, it } from "vitest";
import { DEFAULT_SIM_CONFIG, runSeason, sourceShares } from "../scripts/sim/season.js";

describe("season simulator", { timeout: 60_000 }, () => {
  const config = { ...DEFAULT_SIM_CONFIG, listings: 4, weeks: 1, tickSeconds: 60 };
  const first = runSeason(config);

  it("replays exactly from the same seed", () => {
    const again = runSeason(config);
    expect(again.daily).toEqual(first.daily);
    expect(again.trades).toEqual(first.trades);
    expect(runSeason({ ...config, seed: 2 }).daily).not.toEqual(first.daily);
  });

  it("books every move of the price to events, trades or noise", () => {
    const result = first;
    expect(result.residual).toBeLessThan(1e-6);
    expect(result.daily).toHaveLength(4 * 7);
    expect(result.events.some((event) => event.kind === "RULING")).toBe(true);
    expect(result.events.some((event) => event.queued)).toBe(true);
    expect(result.events.filter((event) => event.kind === "EARNINGS")).toHaveLength(4);
    expect(result.trades.count).toBeGreaterThan(0);
    const { events, trades, noise } = result.shares.daily;
    expect(events + trades + noise).toBeCloseTo(1, 12);
    for (const share of [events, trades, noise]) expect(share).toBeGreaterThan(0);
  });

  it("measures shares as Σ|Δ| (or Σ Δ²) per source", () => {
    const deltas = [{ events: 0.03, trades: -0.01, noise: 0.01 }, { events: -0.03, trades: 0.01, noise: 0 }];
    const shares = sourceShares(deltas);
    expect(shares.events).toBeCloseTo(0.06 / 0.09, 12);
    expect(shares.trades).toBeCloseTo(0.02 / 0.09, 12);
    expect(shares.noise).toBeCloseTo(0.01 / 0.09, 12);
    expect(sourceShares(deltas, 2).events).toBeCloseTo(0.0018 / 0.0021, 12);
  });
});
