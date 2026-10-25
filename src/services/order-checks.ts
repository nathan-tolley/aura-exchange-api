import { Decimal } from "decimal.js";
import { money, shares } from "../core/format.js";
import { quoteTrade, type MarketQuote, type MarketState as Reserves } from "../core/market.js";
import { appError, type ErrorCode, type ErrorParams } from "../errors.js";
import type { TradeSide } from "../types.js";
import type { PortfolioTotals } from "./portfolio-service.js";
import { SHORT_MARGIN, type PositionRow } from "./trade-execution.js";

/** PLAN.md → Trading: one order takes at most 10% of the pool; shorts are capped at 20% of equity per stock, 50% in total. */
export const MAX_ORDER_SHARE_OF_POOL = new Decimal("0.10");
export const SHORT_CAP_PER_STOCK = new Decimal("0.20");
export const SHORT_CAP_TOTAL = new Decimal("0.50");

const STEP = new Decimal("0.0001");

export interface OrderContext {
  side: TradeSide;
  reserves: Reserves;
  feeRate: Decimal;
  position: PositionRow | null;
  cash: Decimal;
  /** Shares already promised to open sell limit orders. */
  reservedSellShares: Decimal;
  totals: PortfolioTotals;
}

interface Failure {
  code: ErrorCode;
  params: ErrorParams;
  message: string;
  /** Whether a smaller order could pass, so the app can offer "Buy 18". */
  reducible: boolean;
}

const zero = new Decimal(0);
const held = (position: PositionRow | null) => ({
  long: new Decimal(position?.long_qty ?? 0),
  short: new Decimal(position?.short_qty ?? 0),
  escrow: new Decimal(position?.short_proceeds ?? 0).plus(position?.short_collateral ?? 0)
});

const shortfall = (needed: Decimal, available: Decimal): Failure => ({
  code: "INSUFFICIENT_CASH",
  params: { needed: money(needed), available: money(available), shortBy: money(needed.minus(available)) },
  message: `You need A$${money(needed.minus(available))} more`,
  reducible: true
});

/** The first rule a quote breaks, or null. The same rules as the /api console's validateOrder, as contract errors. */
function evaluate(ctx: OrderContext, quote: MarketQuote): Failure | null {
  const quantity = new Decimal(quote.quantity);
  const gross = new Decimal(quote.grossAmount);
  const net = new Decimal(quote.netAmount);
  const position = held(ctx.position);
  const positionId = ctx.position?.id ?? "";
  if (ctx.side === "BUY") {
    if (position.short.gt(0)) return { code: "OPPOSITE_POSITION", params: { positionId }, message: "Cover your short before buying", reducible: false };
    if (ctx.cash.lt(net)) return shortfall(net, ctx.cash);
  } else if (ctx.side === "SELL") {
    const available = Decimal.max(zero, position.long.minus(ctx.reservedSellShares));
    if (available.lt(quantity)) return { code: "INSUFFICIENT_SHARES", params: { available: shares(available) }, message: "You don't have that many shares to sell", reducible: true };
  } else if (ctx.side === "SHORT") {
    if (position.long.gt(0)) return { code: "OPPOSITE_POSITION", params: { positionId }, message: "Sell your shares before shorting", reducible: false };
    const margin = gross.mul(SHORT_MARGIN);
    if (ctx.cash.lt(margin)) return shortfall(margin, ctx.cash);
    const stockExposure = position.short.mul(quote.currentPrice).plus(gross);
    if (stockExposure.gt(ctx.totals.equity.mul(SHORT_CAP_PER_STOCK))) {
      return { code: "SHORT_CAP", params: { capPct: "20.00" }, message: "A short on one stock is capped at 20% of your equity", reducible: true };
    }
    if (ctx.totals.shortLiability.plus(gross).gt(ctx.totals.equity.mul(SHORT_CAP_TOTAL))) {
      return { code: "SHORT_CAP", params: { capPct: "50.00" }, message: "Shorts are capped at 50% of your equity in total", reducible: true };
    }
  } else {
    if (position.short.lt(quantity)) return { code: "INSUFFICIENT_SHARES", params: { available: shares(position.short) }, message: "You haven't shorted that many shares", reducible: true };
    const released = position.escrow.mul(quantity.div(position.short));
    const deficit = net.minus(released);
    if (deficit.gt(0) && ctx.cash.lt(deficit)) return shortfall(deficit, ctx.cash);
  }
  return null;
}

/** The largest quantity (in 0.0001 steps, up to `upper`) the rules accept. They only get harder as the order grows. */
function largestPassing(ctx: OrderContext, upper: Decimal): Decimal {
  let low = 0;
  let high = upper.div(STEP).floor().toNumber();
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const quantity = STEP.mul(mid);
    if (evaluate(ctx, quoteTrade(ctx.reserves, ctx.side, quantity, ctx.feeRate)) === null) low = mid;
    else high = mid - 1;
  }
  return STEP.mul(low);
}

/** Quotes the order, or throws the contract error the app turns into the rejection screen (W05). */
export function checkOrder(ctx: OrderContext, quantity: Decimal): MarketQuote {
  if (!quantity.isFinite() || quantity.lte(0)) throw appError("VALIDATION", { field: "quantity", rule: "positive" }, "Quantity must be positive");
  const poolCap = new Decimal(ctx.reserves.shareReserve).mul(MAX_ORDER_SHARE_OF_POOL).div(STEP).floor().mul(STEP);
  if (quantity.gt(poolCap)) {
    throw appError("ORDER_TOO_LARGE", { maxQuantity: shares(poolCap) }, "One order can take at most 10% of the pool");
  }
  const quote = quoteTrade(ctx.reserves, ctx.side, quantity, ctx.feeRate);
  const failure = evaluate(ctx, quote);
  if (!failure) return quote;
  const params = failure.reducible ? { ...failure.params, maxQuantity: shares(largestPassing(ctx, Decimal.min(poolCap, quantity))) } : failure.params;
  throw appError(failure.code, params, failure.message);
}
