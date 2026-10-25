import { Decimal } from "decimal.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { appError } from "../errors.js";
import { loadExchange, tradingState } from "../services/exchange-service.js";
import {
  auraIndex, badgesOf, BORROW_FEE_DAILY, candles, type ListingMarketRow, listingMarketRows, listingState, listingStats, sparklines, spot
} from "../services/market-data-service.js";
import { membershipGuard, requireScopedResource } from "./membership.js";
import { formatTicker, isoTime, isoTimeOrNull, money, percentOfRatio, shares } from "./serialize.js";
import { freshness } from "./views.js";

function listingSummary(row: ListingMarketRow, userId: string, now: Date, sparkline: Decimal[]) {
  const price = spot(row);
  const long = new Decimal(row.my_long);
  const short = new Decimal(row.my_short);
  return {
    id: row.id,
    ticker: formatTicker(row.ticker),
    displayName: row.display_name,
    avatarUrl: null,
    price: money(price),
    changeAbs: money(price.minus(row.day_open_price)),
    changePct: percentOfRatio(price.div(row.day_open_price).minus(1)),
    state: listingState(row, now),
    badges: badgesOf(row),
    sparkline: sparkline.map((point) => money(point)),
    isMine: row.owner_user_id === userId,
    myPosition: long.gt(0) ? { side: "LONG", quantity: shares(long) } : short.gt(0) ? { side: "SHORT", quantity: shares(short) } : null
  };
}

export async function registerMarketRoutes(v1: FastifyInstance, options: { now: () => Date }): Promise<void> {
  v1.get("/exchanges/:exchangeId/market", { preHandler: membershipGuard() }, async (request) => {
    const now = options.now();
    const exchange = (await loadExchange(pool, request.membership!.exchangeId))!;
    const userId = request.v1User!.id;
    const rows = await listingMarketRows(pool, { exchangeId: exchange.id, userId, activeOnly: true });
    const lines = rows.length ? await sparklines(pool, rows[0]!.season_id, rows) : new Map<string, Decimal[]>();
    const index = auraIndex(rows);
    return {
      ...freshness(exchange, now),
      exchangeId: exchange.id,
      index: { name: "AURA", value: money(index.value), changePct: percentOfRatio(index.changeRatio) },
      listings: rows.map((row) => listingSummary(row, userId, now, lines.get(row.id) ?? [])),
      queuedEventsCount: 0,
      tradingEnabled: (await tradingState(pool, exchange.id)).tradingEnabled
    };
  });

  v1.get("/listings/:listingId", async (request) => {
    const listingId = (request.params as { listingId: string }).listingId;
    const membership = await requireScopedResource(pool, request, "listings", listingId);
    const now = options.now();
    const exchange = (await loadExchange(pool, membership.exchangeId))!;
    const userId = request.v1User!.id;
    const [row] = await listingMarketRows(pool, { exchangeId: exchange.id, userId, listingId, activeOnly: false });
    if (!row) throw appError("NOT_FOUND", { resource: "listing" }, "No such listing");
    const [lines, stats] = await Promise.all([sparklines(pool, row.season_id, [row]), listingStats(pool, row.season_id, row.id)]);
    const fresh = freshness(exchange, now);
    const price = spot(row);
    const highLow = (high: string | null, low: string | null, extra: Decimal[]) => {
      const values = [price, ...extra, ...[high, low].filter((value): value is string => value !== null).map((value) => new Decimal(value))];
      return { high: money(Decimal.max(...values)), low: money(Decimal.min(...values)) };
    };
    const day = highLow(stats.day_high, stats.day_low, []);
    const season = highLow(stats.season_high, stats.season_low, [new Decimal(row.opening_price)]);
    return {
      ...fresh,
      ...listingSummary(row, userId, now, lines.get(row.id) ?? []),
      prevClose: money(row.day_open_price),
      open: fresh.marketState === "OPEN" || fresh.marketState === "AFTER" ? money(row.day_open_price) : null,
      dayHigh: day.high,
      dayLow: day.low,
      seasonHigh: season.high,
      seasonLow: season.low,
      volume: shares(stats.volume),
      shortInterestPct: percentOfRatio(new Decimal(row.short_shares).div(row.share_reserve)),
      borrowFeeDailyPct: percentOfRatio(BORROW_FEE_DAILY),
      // Queued rulings, news halts, events and analyst ratings arrive with the Phase 1 event pipeline.
      indicatedPrice: null,
      indicatedChangePct: null,
      halt: null,
      lastTradeAt: isoTimeOrNull(stats.last_trade_at),
      events: [],
      analyst: null
    };
  });

  v1.get("/listings/:listingId/candles", async (request) => {
    const listingId = (request.params as { listingId: string }).listingId;
    const membership = await requireScopedResource(pool, request, "listings", listingId);
    const range = z.object({ range: z.enum(["1D", "1W", "1M", "SEASON"]).default("1D") }).parse(request.query).range;
    const exchange = (await loadExchange(pool, membership.exchangeId))!;
    const [row] = await listingMarketRows(pool, { exchangeId: exchange.id, userId: request.v1User!.id, listingId, activeOnly: false });
    if (!row) throw appError("NOT_FOUND", { resource: "listing" }, "No such listing");
    const series = await candles(pool, row.season_id, row.id, range);
    return {
      ...freshness(exchange, options.now()),
      interval: series.interval,
      candles: series.rows.map((candle) => ({
        t: isoTime(candle.t), o: money(candle.o), h: money(candle.h), l: money(candle.l), c: money(candle.c), v: shares(candle.v)
      })),
      markers: [],
      prevClose: money(row.day_open_price)
    };
  });
}
