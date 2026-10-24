import { describe, expect, it } from "vitest";
import { buildCandles, CANDLE_TIMEFRAMES, type PriceTick } from "../web/src/candles.js";

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

  it("uses zoom windows appropriate to each supported candle interval",()=>{
    expect(CANDLE_TIMEFRAMES.ONE_MINUTE).toMatchObject({label:"1m",intervalMs:60_000,windowMs:7_200_000});
    expect(CANDLE_TIMEFRAMES.FIFTEEN_MINUTES).toMatchObject({label:"15m",intervalMs:900_000,windowMs:86_400_000});
    expect(CANDLE_TIMEFRAMES.ONE_HOUR).toMatchObject({label:"1h",intervalMs:3_600_000,windowMs:604_800_000});
  });
});
