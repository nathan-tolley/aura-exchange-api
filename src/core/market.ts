import { Decimal } from "decimal.js";
import type { TradeSide } from "../types.js";
import { badRequest } from "../errors.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface MarketState {
  shareReserve: Decimal.Value;
  creditReserve: Decimal.Value;
}

export interface MarketQuote {
  side: TradeSide;
  quantity: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  executionPrice: string;
  currentPrice: string;
  nextPrice: string;
  priceImpact: string;
  nextShareReserve: string;
  nextCreditReserve: string;
  reserveVersion: string;
}

const money = (value: Decimal) => value.toDecimalPlaces(8).toFixed(8);

export function spotPrice(state: MarketState): Decimal {
  return new Decimal(state.creditReserve).div(state.shareReserve);
}

export function reserveVersion(state: MarketState): string {
  return `${new Decimal(state.shareReserve).toFixed(8)}:${new Decimal(state.creditReserve).toFixed(8)}`;
}

export function quoteTrade(
  state: MarketState,
  side: TradeSide,
  quantityValue: Decimal.Value,
  feeRate = new Decimal("0.005")
): MarketQuote {
  const shares = new Decimal(state.shareReserve);
  const credits = new Decimal(state.creditReserve);
  const quantity = new Decimal(quantityValue);

  if (!quantity.isFinite() || quantity.lte(0)) throw badRequest("Quantity must be positive", "INVALID_QUANTITY");
  if (quantity.gt(shares.mul("0.10"))) {
    throw badRequest("Order exceeds 10% of current pool liquidity", "ORDER_TOO_LARGE");
  }

  const buysFromPool = side === "BUY" || side === "COVER";
  const nextShares = buysFromPool ? shares.minus(quantity) : shares.plus(quantity);
  if (nextShares.lte(0)) throw badRequest("Insufficient market liquidity", "INSUFFICIENT_LIQUIDITY");

  const invariant = shares.mul(credits);
  const nextCredits = invariant.div(nextShares);
  const gross = buysFromPool ? nextCredits.minus(credits) : credits.minus(nextCredits);
  const fee = gross.mul(feeRate);
  const net = buysFromPool ? gross.plus(fee) : gross.minus(fee);
  const currentPrice = credits.div(shares);
  const nextPrice = nextCredits.div(nextShares);
  const executionPrice = gross.div(quantity);
  const impact = executionPrice.div(currentPrice).minus(1).abs();

  return {
    side,
    quantity: money(quantity),
    grossAmount: money(gross),
    feeAmount: money(fee),
    netAmount: money(net),
    executionPrice: money(executionPrice),
    currentPrice: money(currentPrice),
    nextPrice: money(nextPrice),
    priceImpact: impact.toDecimalPlaces(8).toFixed(8),
    nextShareReserve: money(nextShares),
    nextCreditReserve: money(nextCredits),
    reserveVersion: reserveVersion(state)
  };
}

export function collateralRatio(escrowValue: Decimal.Value, coverCost: Decimal.Value): Decimal {
  const liability = new Decimal(coverCost);
  if (liability.lte(0)) return new Decimal(Infinity);
  return new Decimal(escrowValue).div(liability);
}

/** PLAN.md → Trading: shorts are liquidated under 125% collateral, warned at 140% (DECISIONS.md). */
export const MAINTENANCE_COLLATERAL = new Decimal("1.25");
export const WARNING_COLLATERAL = new Decimal("1.40");

export function isLiquidatable(escrowValue: Decimal.Value, coverCost: Decimal.Value): boolean {
  return collateralRatio(escrowValue, coverCost).lt(MAINTENANCE_COLLATERAL);
}

export function auraComposite(deltas: number[]): number {
  if (deltas.length === 0) return 100;
  return Math.max(0, 100 + deltas.reduce((sum, value) => sum + value, 0) / deltas.length);
}

export function marketIndex(priceRatios: Decimal.Value[]): number {
  if (priceRatios.length === 0) return 100;
  const total = priceRatios.reduce<Decimal>((sum, ratio) => sum.plus(ratio), new Decimal(0));
  return total.div(priceRatios.length).mul(100).toNumber();
}

export function marketAuraAdjustment(side: TradeSide, grossAmount: Decimal.Value): Decimal {
  const magnitude = Decimal.min(new Decimal(grossAmount).abs().div(1000), 10).toDecimalPlaces(2);
  return side === "BUY" || side === "COVER" ? magnitude : magnitude.negated();
}

