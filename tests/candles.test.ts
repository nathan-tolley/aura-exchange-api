import { describe, expect, it } from "vitest";
import { buildCandles, type PriceTick } from "../web/src/candles.js";

describe("buildCandles", () => {
  it("builds ordered OHLC candles and marks trade-containing buckets", () => {
    const ticks: PriceTick[] = [
      { timestamp: "2026-10-23T12:14:00Z", price: 101, cause: "AMBIENT", referenceId: null, feedEventId: null, synthetic: true },
      { timestamp: "2026-10-23T12:01:00Z", price: 100, cause: "AMBIENT", referenceId: null, feedEventId: null, synthetic: true },
      { timestamp: "2026-10-23T12:10:00Z", price: 99, cause: "TRADE", referenceId: "trade", feedEventId: "event", synthetic: false },
      { timestamp: "2026-10-23T12:16:00Z", price: 102, cause: "AMBIENT", referenceId: null, feedEventId: null, synthetic: true }
    ];
    expect(buildCandles(ticks, 15 * 60_000)).toEqual([
      { timestamp: "2026-10-23T12:00:00.000Z", open: 100, high: 101, low: 99, close: 101, syntheticOnly: false, feedEventIds: ["event"] },
      { timestamp: "2026-10-23T12:15:00.000Z", open: 101, high: 102, low: 101, close: 102, syntheticOnly: true, feedEventIds: [] }
    ]);
  });
});
