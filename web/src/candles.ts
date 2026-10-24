export interface PriceTick {
  timestamp: string;
  price: number;
  cause: "OPEN" | "TRADE" | "AMBIENT";
  referenceId: string | null;
  feedEventId: string | null;
  synthetic: boolean;
}

export interface Candle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  syntheticOnly: boolean;
  feedEventIds: string[];
}

export const CANDLE_TIMEFRAMES = {
  ONE_MINUTE: { label: "1m", intervalMs: 60_000, windowMs: 2 * 60 * 60_000 },
  FIFTEEN_MINUTES: { label: "15m", intervalMs: 15 * 60_000, windowMs: 24 * 60 * 60_000 },
  ONE_HOUR: { label: "1h", intervalMs: 60 * 60_000, windowMs: 7 * 24 * 60 * 60_000 }
} as const;

export type CandleTimeframe = keyof typeof CANDLE_TIMEFRAMES;

export function buildCandles(ticks: PriceTick[], intervalMs: number): Candle[] {
  const ordered = [...ticks].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const candles = new Map<number, Candle>();
  let previousClose: number | undefined;
  for (const tick of ordered) {
    const time = Date.parse(tick.timestamp);
    const bucket = Math.floor(time / intervalMs) * intervalMs;
    const existing = candles.get(bucket);
    if (!existing) {
      const open = previousClose ?? tick.price;
      candles.set(bucket, { timestamp: new Date(bucket).toISOString(), open, high: Math.max(open,tick.price), low: Math.min(open,tick.price), close: tick.price, syntheticOnly: tick.synthetic, feedEventIds: tick.feedEventId ? [tick.feedEventId] : [] });
      previousClose = tick.price;
      continue;
    }
    existing.high = Math.max(existing.high, tick.price);
    existing.low = Math.min(existing.low, tick.price);
    existing.close = tick.price;
    existing.syntheticOnly = existing.syntheticOnly && tick.synthetic;
    if (tick.feedEventId && !existing.feedEventIds.includes(tick.feedEventId)) existing.feedEventIds.push(tick.feedEventId);
    previousClose = tick.price;
  }
  return [...candles.values()];
}
