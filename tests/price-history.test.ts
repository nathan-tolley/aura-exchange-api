import { describe, expect, it } from "vitest";
import { replayPriceHistory } from "../src/core/price-history.js";

describe("stock price history", () => {
  it("replays post-trade AMM prices and preserves their causes", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const points = replayPriceHistory(start, [
      { id: "buy", side: "BUY", quantity: 10, grossAmount: 1010.1010101, createdAt: new Date("2026-01-02T00:00:00Z"), actorName: "Alex" },
      { id: "sell", side: "SELL", quantity: 5, grossAmount: 507.58844729, createdAt: new Date("2026-01-03T00:00:00Z"), actorName: "Blair" }
    ]);
    expect(points).toHaveLength(3);
    expect(points[1]!.price).toBeGreaterThan(100);
    expect(points[2]!.price).toBeLessThan(points[1]!.price);
    expect(points[1]!.cause).toMatchObject({ type: "TRADE", tradeId: "buy", side: "BUY", actorName: "Alex" });
  });
});
