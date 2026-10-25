import { Decimal } from "decimal.js";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { accountBalance, accounts } from "../core/ledger.js";
import { marketSession, nextWeeklyPayoutAt } from "../core/market-hours.js";
import { quoteTrade, reserveVersion, type MarketQuote } from "../core/market.js";
import { maybeOne, one, pool, withTransaction } from "../db.js";
import { appError } from "../errors.js";
import { type ExchangeRow, hoursOf, loadExchange, tradingState } from "../services/exchange-service.js";
import { checkOrder, type OrderContext } from "../services/order-checks.js";
import { portfolioTotals } from "../services/portfolio-service.js";
import { executeTrade, loadPosition, type PoolRow, type PositionRow, SHORT_MARGIN } from "../services/trade-execution.js";
import type { TradeSide } from "../types.js";
import { requireScopedResource } from "./membership.js";
import { liquidationPrice, positionViews } from "./positions.js";
import { formatTicker, isoTime, money, percentOfRatio, shares } from "./serialize.js";
import { freshness, listingRef } from "./views.js";

/** A quote holds its price for 15 seconds (PLAN.md → Orders). */
export const QUOTE_SECONDS = 15;

const quantityString = z.string().regex(/^\d+(\.\d{1,4})?$/);

interface TradableRow extends PoolRow {
  ticker: string;
  display_name: string;
  owner_user_id: string | null;
  is_active: boolean;
}

/** Phase 0 has market orders only: they need the regular session, enough listings, and the stock not halted. */
async function assertTradable(exchange: ExchangeRow, listing: TradableRow, userId: string, now: Date): Promise<void> {
  const session = marketSession(hoursOf(exchange), exchange.timezone, now);
  if (session.state === "CLOSED") {
    throw appError("MARKET_CLOSED", { opensAt: isoTime(session.opensAt), queuedEvents: "0" }, "The market is closed");
  }
  if (session.state !== "OPEN") {
    throw appError("ORDER_TYPE_NOT_ALLOWED", { marketState: session.state }, "Only limit orders trade outside regular hours");
  }
  const trading = await tradingState(pool, exchange.id);
  if (!trading.tradingEnabled) {
    throw appError("TRADING_NOT_OPEN", { listedCount: String(trading.listedCount), minListingsToOpen: String(trading.minListingsToOpen) }, "Trading opens once enough members are listed");
  }
  if (!listing.is_active) throw appError("NOT_FOUND", { resource: "listing" }, "That listing is delisted");
  if (listing.owner_user_id === userId) throw appError("SELF_TRADE", { ticker: formatTicker(listing.ticker) }, "You can't trade your own stock");
  if (listing.halted_until && listing.halted_until > now) {
    throw appError("LISTING_HALTED", { haltId: "", resumesAt: isoTime(listing.halted_until) }, "Trading in this stock is halted");
  }
}

async function loadTradable(client: Pick<PoolClient, "query">, listingId: string, lock: boolean): Promise<TradableRow> {
  const row = await maybeOne<TradableRow>(client,
    `SELECT mp.id, mp.season_id, mp.stock_id, mp.share_reserve::text, mp.credit_reserve::text, mp.day_open_price::text, mp.halted_until,
            l.ticker::text, l.display_name, l.owner_user_id, l.is_active
       FROM listings l
       JOIN market_pools mp ON mp.stock_id=l.id
       JOIN seasons s ON s.id=mp.season_id AND s.status='ACTIVE' AND s.exchange_id=l.exchange_id
      WHERE l.id=$1 ${lock ? "FOR UPDATE OF mp" : ""}`,
    [listingId]
  );
  // A roster entry nobody has claimed yet has no pool to trade against.
  if (!row) throw appError("NOT_FOUND", { resource: "listing" }, "That listing isn't trading");
  return row;
}

async function orderContext(client: PoolClient, input: {
  userId: string; exchange: ExchangeRow; now: Date; listing: TradableRow; side: TradeSide; feeRate: Decimal; position: PositionRow | null;
}): Promise<OrderContext> {
  const seasonId = input.listing.season_id;
  const reserved = await one<{ quantity: string }>(client,
    "SELECT COALESCE(SUM(quantity),0)::text AS quantity FROM limit_orders WHERE season_id=$1 AND user_id=$2 AND stock_id=$3 AND side='SELL' AND status='OPEN'",
    [seasonId, input.userId, input.listing.stock_id]
  );
  return {
    side: input.side,
    reserves: { shareReserve: input.listing.share_reserve, creditReserve: input.listing.credit_reserve },
    feeRate: input.feeRate,
    position: input.position,
    cash: await accountBalance(client, accounts.userCash(input.userId, seasonId)),
    reservedSellShares: new Decimal(reserved.quantity),
    totals: await portfolioTotals(client, input.userId, seasonId),
    nextStimulusAt: isoTime(nextWeeklyPayoutAt(input.exchange.timezone, input.now))
  };
}

/** The cash the trade moves: buys and covers pay, sells receive, shorts put up the margin. */
function cashChange(side: TradeSide, quote: MarketQuote, position: PositionRow | null): Decimal {
  const net = new Decimal(quote.netAmount);
  if (side === "BUY") return net.negated();
  if (side === "SELL") return net;
  if (side === "SHORT") return new Decimal(quote.grossAmount).mul(SHORT_MARGIN).negated();
  const short = new Decimal(position?.short_qty ?? 0);
  const escrow = new Decimal(position?.short_proceeds ?? 0).plus(position?.short_collateral ?? 0);
  return escrow.mul(new Decimal(quote.quantity).div(short)).minus(net);
}

function shortBlock(side: TradeSide, quote: MarketQuote, position: PositionRow | null) {
  if (side !== "SHORT") return null;
  const margin = new Decimal(quote.grossAmount).mul(SHORT_MARGIN);
  const quantityAfter = new Decimal(position?.short_qty ?? 0).plus(quote.quantity);
  const escrowAfter = new Decimal(position?.short_proceeds ?? 0).plus(position?.short_collateral ?? 0).plus(quote.netAmount).plus(margin);
  return { collateralRequired: money(margin), liquidationPrice: money(liquidationPrice(escrowAfter, quantityAfter)) };
}

export async function registerTradingRoutes(v1: FastifyInstance, options: { now: () => Date }): Promise<void> {
  v1.post("/quotes", async (request, reply) => {
    const input = z.object({
      listingId: z.string().uuid(),
      side: z.enum(["BUY", "SELL", "SHORT", "COVER"]),
      quantity: quantityString,
      previousQuoteId: z.string().uuid().nullish()
    }).parse(request.body);
    const membership = await requireScopedResource(pool, request, "listings", input.listingId);
    const userId = request.v1User!.id;
    const now = options.now();
    const exchange = (await loadExchange(pool, membership.exchangeId))!;
    const listing = await loadTradable(pool, input.listingId, false);
    await assertTradable(exchange, listing, userId, now);

    const result = await withTransaction(async (client) => {
      const position = await maybeOne<PositionRow>(client,
        "SELECT * FROM positions WHERE season_id=$1 AND user_id=$2 AND stock_id=$3", [listing.season_id, userId, listing.stock_id]
      );
      const feeRate = new Decimal(exchange.fee_rate);
      const ctx = await orderContext(client, { userId, exchange, now, listing, side: input.side, feeRate, position });
      const quote = checkOrder(ctx, new Decimal(input.quantity));
      const saved = await one<{ id: string; expires_at: Date }>(client,
        `INSERT INTO trade_quotes(exchange_id, season_id, user_id, stock_id, side, quantity, gross_amount, fee_amount,
           net_amount, execution_price, price_impact, reserve_version, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now() + make_interval(secs => $13)) RETURNING id, expires_at`,
        [exchange.id, listing.season_id, userId, listing.stock_id, input.side, quote.quantity, quote.grossAmount, quote.feeAmount,
          quote.netAmount, quote.executionPrice, quote.priceImpact, quote.reserveVersion, QUOTE_SECONDS]
      );
      const previous = input.previousQuoteId
        ? await maybeOne<{ id: string; execution_price: string; net_amount: string }>(client,
          "SELECT id,execution_price::text,net_amount::text FROM trade_quotes WHERE id=$1 AND user_id=$2 AND stock_id=$3",
          [input.previousQuoteId, userId, listing.stock_id])
        : null;
      return { quote, saved, previous, cashAfter: ctx.cash.plus(cashChange(input.side, quote, position)), feeRate, position };
    });

    reply.code(201);
    const { quote, saved, previous } = result;
    return {
      ...freshness(exchange, now),
      id: saved.id,
      listingId: input.listingId,
      side: input.side,
      quantity: shares(quote.quantity),
      price: money(quote.executionPrice),
      gross: money(quote.grossAmount),
      feeRate: percentOfRatio(result.feeRate),
      fee: money(quote.feeAmount),
      total: money(quote.netAmount),
      priceImpactPct: percentOfRatio(quote.priceImpact),
      currentPrice: money(quote.currentPrice),
      expiresAt: isoTime(saved.expires_at),
      previous: previous ? {
        quoteId: previous.id,
        price: money(previous.execution_price),
        total: money(previous.net_amount),
        changePct: percentOfRatio(new Decimal(quote.executionPrice).div(previous.execution_price).minus(1))
      } : null,
      short: shortBlock(input.side, quote, result.position),
      cashAfter: money(result.cashAfter)
    };
  });

  v1.post("/trades", async (request, reply) => {
    const input = z.object({ quoteId: z.string().uuid() }).parse(request.body);
    const membership = await requireScopedResource(pool, request, "trade_quotes", input.quoteId);
    const userId = request.v1User!.id;
    // The idempotency layer already replays repeats; the trades table's (user, key) uniqueness is the second guard.
    const idempotencyKey = String(request.headers["idempotency-key"]);
    const now = options.now();
    const exchange = (await loadExchange(pool, membership.exchangeId))!;

    const executed = await withTransaction(async (client) => {
      const quote = await maybeOne<{
        id: string; season_id: string; user_id: string; stock_id: string; side: TradeSide; quantity: string;
        execution_price: string; reserve_version: string; expired: boolean; consumed_at: Date | null;
      }>(client,
        "SELECT id,season_id,user_id,stock_id,side,quantity::text,execution_price::text,reserve_version,expires_at<=now() AS expired,consumed_at FROM trade_quotes WHERE id=$1 FOR UPDATE",
        [input.quoteId]
      );
      if (!quote || quote.user_id !== userId) throw appError("NOT_FOUND", { resource: "quote" }, "No such quote");
      const listing = await loadTradable(client, quote.stock_id, true);
      await assertTradable(exchange, listing, userId, now);
      const reserves = { shareReserve: listing.share_reserve, creditReserve: listing.credit_reserve };
      const feeRate = new Decimal(exchange.fee_rate);
      const stale = (newPrice: Decimal.Value) => appError("QUOTE_STALE", {
        oldPrice: money(quote.execution_price),
        newPrice: money(newPrice),
        changePct: percentOfRatio(new Decimal(newPrice).div(quote.execution_price).minus(1))
      }, "The price moved; get a new quote");
      const freshPrice = () => {
        try {
          return quoteTrade(reserves, quote.side, quote.quantity, feeRate).executionPrice;
        } catch {
          return new Decimal(listing.credit_reserve).div(listing.share_reserve);
        }
      };
      if (quote.consumed_at || quote.expired || reserveVersion(reserves) !== quote.reserve_version) throw stale(freshPrice());

      const position = await loadPosition(client, userId, quote.stock_id, quote.season_id, true);
      const ctx = await orderContext(client, { userId, exchange, now, listing, side: quote.side, feeRate, position });
      const calculated = checkOrder(ctx, new Decimal(quote.quantity));
      const { tradeId, executedAt } = await executeTrade(client, {
        userId, quoteId: quote.id, seasonId: quote.season_id, stockId: quote.stock_id, side: quote.side,
        idempotencyKey, market: listing, position, calculated, auraCoupling: false
      });
      const cashAfter = await accountBalance(client, accounts.userCash(userId, quote.season_id));
      const [positionAfter] = await positionViews(client, userId, quote.season_id, quote.stock_id);
      return { tradeId, executedAt, calculated, quote, listing, cashAfter, positionAfter: positionAfter ?? null };
    });

    reply.code(201);
    const { calculated, quote, listing } = executed;
    return {
      id: executed.tradeId,
      quoteId: quote.id,
      listing: listingRef({ id: listing.stock_id, ticker: listing.ticker, display_name: listing.display_name }),
      side: quote.side,
      quantity: shares(calculated.quantity),
      price: money(calculated.executionPrice),
      fee: money(calculated.feeAmount),
      total: money(calculated.netAmount),
      cashAfter: money(executed.cashAfter),
      position: executed.positionAfter,
      executedAt: isoTime(executed.executedAt)
    };
  });
}
