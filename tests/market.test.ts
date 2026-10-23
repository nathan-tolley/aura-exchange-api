import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { auraComposite, collateralRatio, isLiquidatable, marketAuraAdjustment, marketIndex, quoteTrade, spotPrice } from "../src/core/market.js";

describe("constant-product market", () => {
  const initial = { shareReserve: 1000, creditReserve: 100000 };

  it("starts at 100 AC and preserves the invariant on a buy", () => {
    expect(spotPrice(initial).toNumber()).toBe(100);
    const quote = quoteTrade(initial, "BUY", 10);
    expect(new Decimal(quote.nextShareReserve).mul(quote.nextCreditReserve).toFixed(2)).toBe("100000000.00");
    expect(Number(quote.nextPrice)).toBeGreaterThan(100);
    expect(new Decimal(quote.netAmount).minus(quote.grossAmount).toFixed(8)).toBe(quote.feeAmount);
  });

  it("moves price down on sells and shorts", () => {
    expect(Number(quoteTrade(initial, "SELL", 10).nextPrice)).toBeLessThan(100);
    expect(Number(quoteTrade(initial, "SHORT", 10).nextPrice)).toBeLessThan(100);
  });

  it("rejects orders over ten percent of liquidity", () => {
    expect(() => quoteTrade(initial, "BUY", 100.0001)).toThrow(/10%/);
  });

  it("calculates collateral maintenance", () => {
    expect(collateralRatio(150, 100).toNumber()).toBe(1.5);
    expect(isLiquidatable(124.99, 100)).toBe(true);
    expect(isLiquidatable(125, 100)).toBe(false);
  });
});

describe("market confidence Aura", () => {
  it("rewards buying and covering while penalizing selling and shorting", () => {
    expect(marketAuraAdjustment("BUY", 2500).toNumber()).toBe(2.5);
    expect(marketAuraAdjustment("COVER", 1000).toNumber()).toBe(1);
    expect(marketAuraAdjustment("SELL", 2500).toNumber()).toBe(-2.5);
    expect(marketAuraAdjustment("SHORT", 1000).toNumber()).toBe(-1);
  });

  it("caps a single trade's confidence effect", () => {
    expect(marketAuraAdjustment("BUY", 25000).toNumber()).toBe(10);
  });
});

describe("indices", () => {
  it("moves the Aura Composite by the equal-weight average delta", () => {
    expect(auraComposite([-5, -5, -5])).toBe(95);
    expect(auraComposite([10, -10])).toBe(100);
  });

  it("tracks the equal-weight market ratio", () => {
    expect(marketIndex([1.1, 0.9, 1])).toBeCloseTo(100);
  });
});

