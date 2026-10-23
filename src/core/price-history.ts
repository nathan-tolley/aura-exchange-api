import { Decimal } from "decimal.js";
import type { TradeSide } from "../types.js";

export interface HistoricalTrade {
  id: string;
  side: TradeSide | "LIQUIDATE";
  quantity: Decimal.Value;
  grossAmount: Decimal.Value;
  createdAt: Date;
  actorName: string;
}

export interface PriceHistoryPoint {
  timestamp: string;
  price: number;
  cause: {
    type: "OPEN" | "TRADE" | "CURRENT";
    tradeId?: string;
    side?: HistoricalTrade["side"];
    quantity?: number;
    actorName?: string;
    priceChange?: number;
  };
}

export function replayPriceHistory(
  startsAt: Date,
  trades: HistoricalTrade[],
  openingShares: Decimal.Value = 1000,
  openingCredits: Decimal.Value = 100_000
): PriceHistoryPoint[] {
  let shares = new Decimal(openingShares);
  let credits = new Decimal(openingCredits);
  let previousPrice = credits.div(shares);
  const points: PriceHistoryPoint[] = [{
    timestamp: startsAt.toISOString(),
    price: previousPrice.toDecimalPlaces(4).toNumber(),
    cause: { type: "OPEN" }
  }];

  for (const trade of trades) {
    const quantity = new Decimal(trade.quantity);
    const gross = new Decimal(trade.grossAmount);
    const buysFromPool = trade.side === "BUY" || trade.side === "COVER" || trade.side === "LIQUIDATE";
    shares = buysFromPool ? shares.minus(quantity) : shares.plus(quantity);
    credits = buysFromPool ? credits.plus(gross) : credits.minus(gross);
    const price = credits.div(shares);
    points.push({
      timestamp: trade.createdAt.toISOString(),
      price: price.toDecimalPlaces(4).toNumber(),
      cause: {
        type: "TRADE",
        tradeId: trade.id,
        side: trade.side,
        quantity: quantity.toNumber(),
        actorName: trade.actorName,
        priceChange: price.minus(previousPrice).toDecimalPlaces(4).toNumber()
      }
    });
    previousPrice = price;
  }
  return points;
}
