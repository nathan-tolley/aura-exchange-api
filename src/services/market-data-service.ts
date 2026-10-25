import { Decimal } from "decimal.js";
import type { Pool, PoolClient } from "pg";

type Db = Pick<Pool | PoolClient, "query">;

/** PLAN.md → Short squeezes: over 20% of the pool shorted, a stock is hard to borrow. */
export const HARD_TO_BORROW_RATIO = new Decimal("0.20");
/** PLAN.md → parody layer: under 5 is a penny stock ("OTC Pink"). */
export const PENNY_PRICE = new Decimal(5);
/** The flat daily borrow fee the worker charges today (0.1%); the Fed and hard-to-borrow ramp come later. */
export const BORROW_FEE_DAILY = new Decimal("0.001");
export const SPARKLINE_POINTS = 48;
/** Candle buckets are UTC, on the same fixed origin the candle trigger uses (db/migrations/017_engine_tick.sql). */
const UTC_ORIGIN = "TIMESTAMPTZ '2000-01-01 00:00:00+00'";

export interface ListingMarketRow {
  id: string;
  ticker: string;
  display_name: string;
  owner_user_id: string | null;
  is_active: boolean;
  season_id: string;
  share_reserve: string;
  credit_reserve: string;
  opening_price: string;
  day_open_price: string;
  halted_until: Date | null;
  short_shares: string;
  my_position_id: string | null;
  my_long: string;
  my_short: string;
}

/** The exchange's listings in its active season, with pool state, short interest and the viewer's own position. */
export async function listingMarketRows(
  db: Db,
  input: { exchangeId: string; userId: string; listingId?: string; activeOnly: boolean }
): Promise<ListingMarketRow[]> {
  const result = await db.query<ListingMarketRow>(
    `SELECT l.id, l.ticker::text, l.display_name, l.owner_user_id, l.is_active, mp.season_id,
            mp.share_reserve::text, mp.credit_reserve::text, mp.opening_price::text, mp.day_open_price::text, mp.halted_until,
            COALESCE((SELECT SUM(p.short_qty) FROM positions p WHERE p.season_id=mp.season_id AND p.stock_id=l.id),0)::text AS short_shares,
            me.id AS my_position_id, COALESCE(me.long_qty,0)::text AS my_long, COALESCE(me.short_qty,0)::text AS my_short
       FROM listings l
       JOIN market_pools mp ON mp.stock_id=l.id
       JOIN seasons s ON s.id=mp.season_id AND s.status='ACTIVE' AND s.exchange_id=l.exchange_id
       LEFT JOIN positions me ON me.season_id=mp.season_id AND me.stock_id=l.id AND me.user_id=$2
      WHERE l.exchange_id=$1 AND l.consented_at IS NOT NULL
        AND ($3::uuid IS NULL OR l.id=$3) AND (NOT $4 OR l.is_active)
      ORDER BY l.ticker`,
    [input.exchangeId, input.userId, input.listingId ?? null, input.activeOnly]
  );
  return result.rows;
}

export const spot = (row: Pick<ListingMarketRow, "share_reserve" | "credit_reserve">) => new Decimal(row.credit_reserve).div(row.share_reserve);

export function listingState(row: ListingMarketRow, now: Date): "ACTIVE" | "HALTED" | "DELISTED" {
  if (!row.is_active) return "DELISTED";
  if (row.halted_until && row.halted_until > now) return "HALTED";
  return "ACTIVE";
}

export function badgesOf(row: ListingMarketRow): string[] {
  const badges: string[] = [];
  if (new Decimal(row.short_shares).div(row.share_reserve).gt(HARD_TO_BORROW_RATIO)) badges.push("HARD_TO_BORROW");
  if (spot(row).lt(PENNY_PRICE)) badges.push("OTC_PINK");
  return badges;
}

/** Up to 48 half-hour points over the last 24 hours (the last price in each), ending at the current price. */
export async function sparklines(db: Db, seasonId: string, rows: ListingMarketRow[]): Promise<Map<string, Decimal[]>> {
  const result = await db.query<{ stock_id: string; price: string }>(
    `SELECT stock_id, (array_agg(c ORDER BY t DESC))[1]::text AS price
       FROM candles_1m
      WHERE season_id=$1 AND stock_id = ANY($2::uuid[]) AND c_at > now() - interval '24 hours'
      GROUP BY stock_id, date_bin('30 minutes', t, ${UTC_ORIGIN})
      ORDER BY stock_id, date_bin('30 minutes', t, ${UTC_ORIGIN})`,
    [seasonId, rows.map((row) => row.id)]
  );
  const lines = new Map<string, Decimal[]>(rows.map((row) => [row.id, []]));
  for (const point of result.rows) lines.get(point.stock_id)!.push(new Decimal(point.price));
  for (const row of rows) {
    const line = lines.get(row.id)!;
    const now = spot(row);
    if (!line.length || !line.at(-1)!.toDecimalPlaces(2).eq(now.toDecimalPlaces(2))) line.push(now);
    lines.set(row.id, line.slice(-SPARKLINE_POINTS));
  }
  return lines;
}

/** The equal-weight AURA index: 100 × the average of price ÷ IPO price, and its move since the day's open. */
export function auraIndex(rows: ListingMarketRow[]): { value: Decimal; changeRatio: Decimal } {
  if (!rows.length) return { value: new Decimal(100), changeRatio: new Decimal(0) };
  const mean = (values: Decimal[]) => values.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(values.length);
  const value = mean(rows.map((row) => spot(row).div(row.opening_price))).mul(100);
  const atOpen = mean(rows.map((row) => new Decimal(row.day_open_price).div(row.opening_price))).mul(100);
  return { value, changeRatio: value.div(atOpen).minus(1) };
}

export interface ListingStats {
  day_high: string | null;
  day_low: string | null;
  season_high: string | null;
  season_low: string | null;
  volume: string;
  last_trade_at: Date | null;
}

export async function listingStats(db: Db, seasonId: string, listingId: string): Promise<ListingStats> {
  const result = await db.query<ListingStats>(
    `SELECT (SELECT MAX(h)::text FROM candles_1m WHERE season_id=$1 AND stock_id=$2 AND c_at > now()-interval '24 hours') AS day_high,
            (SELECT MIN(l)::text FROM candles_1m WHERE season_id=$1 AND stock_id=$2 AND c_at > now()-interval '24 hours') AS day_low,
            (SELECT MAX(h)::text FROM candles_1h WHERE season_id=$1 AND stock_id=$2) AS season_high,
            (SELECT MIN(l)::text FROM candles_1h WHERE season_id=$1 AND stock_id=$2) AS season_low,
            (SELECT COALESCE(SUM(quantity),0)::text FROM trades WHERE season_id=$1 AND stock_id=$2 AND created_at > now()-interval '24 hours') AS volume,
            (SELECT MAX(created_at) FROM trades WHERE season_id=$1 AND stock_id=$2) AS last_trade_at`,
    [seasonId, listingId]
  );
  return result.rows[0]!;
}

export type CandleRange = "1D" | "1W" | "1M" | "SEASON";

/** Each range rolls up the finest stored candles that cover it: 1-minute candles for a day, 1-hour ones beyond. */
const RANGES: Record<CandleRange, { interval: "5m" | "1h" | "1d"; bucket: string; window: string | null; source: "candles_1m" | "candles_1h" }> = {
  "1D": { interval: "5m", bucket: "5 minutes", window: "24 hours", source: "candles_1m" },
  "1W": { interval: "1h", bucket: "1 hour", window: "7 days", source: "candles_1h" },
  "1M": { interval: "1d", bucket: "1 day", window: "30 days", source: "candles_1h" },
  SEASON: { interval: "1d", bucket: "1 day", window: null, source: "candles_1h" }
};

export interface CandleRow {
  t: Date;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

/** OHLC rolled up from the stored candles and volume from the trades, in UTC buckets; empty buckets are left out. */
export async function candles(db: Db, seasonId: string, listingId: string, range: CandleRange): Promise<{ interval: string; rows: CandleRow[] }> {
  const spec = RANGES[range];
  const since = spec.window ? `now() - interval '${spec.window}'` : "'-infinity'::timestamptz";
  const result = await db.query<CandleRow>(
    `WITH prices AS (
       SELECT date_bin($3::interval, t, ${UTC_ORIGIN}) AS t,
              (array_agg(o ORDER BY t))[1] AS o, MAX(h) AS h, MIN(l) AS l, (array_agg(c ORDER BY t DESC))[1] AS c
         FROM ${spec.source} WHERE season_id=$1 AND stock_id=$2 AND c_at >= ${since} GROUP BY 1
     ), volume AS (
       SELECT date_bin($3::interval, created_at, ${UTC_ORIGIN}) AS t, SUM(quantity) AS v
         FROM trades WHERE season_id=$1 AND stock_id=$2 AND created_at >= ${since} GROUP BY 1
     )
     SELECT prices.t, prices.o::text, prices.h::text, prices.l::text, prices.c::text, COALESCE(volume.v,0)::text AS v
       FROM prices LEFT JOIN volume ON volume.t=prices.t ORDER BY prices.t`,
    [seasonId, listingId, spec.bucket]
  );
  return { interval: spec.interval, rows: result.rows };
}
