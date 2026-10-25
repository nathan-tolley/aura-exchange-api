import { Decimal } from "decimal.js";
import type { FastifyInstance } from "fastify";
import { accounts } from "../core/ledger.js";
import { nextWeeklyPayoutAt } from "../core/market-hours.js";
import { one, pool, withTransaction } from "../db.js";
import { appError } from "../errors.js";
import { activeSeason, loadExchange } from "../services/exchange-service.js";
import { portfolioTotals } from "../services/portfolio-service.js";
import { membershipGuard } from "./membership.js";
import { positionViews } from "./positions.js";
import { isoTime, money, percentOfRatio, shares } from "./serialize.js";
import { freshness, listingRef } from "./views.js";

/** PLAN.md → Personal bankruptcy: below A$100 of equity a trader may declare Chapter 7 (Phase 2). */
export const BANKRUPTCY_EQUITY = new Decimal(100);

const ratio = (part: Decimal, whole: Decimal) => (whole.isZero() ? new Decimal(0) : part.div(whole));

export async function registerPortfolioRoutes(v1: FastifyInstance, options: { now: () => Date }): Promise<void> {
  v1.get("/exchanges/:exchangeId/portfolio", { preHandler: membershipGuard() }, async (request) => {
    const exchange = (await loadExchange(pool, request.membership!.exchangeId))!;
    const userId = request.v1User!.id;
    const season = await activeSeason(pool, exchange.id);
    if (!season) throw appError("NOT_FOUND", { resource: "season" }, "This exchange has no active season");

    const data = await withTransaction(async (client) => {
      const totals = await portfolioTotals(client, userId, season.id);
      const figures = await one<{ reserved: string; contributed: string; day_change: string }>(client,
        `SELECT
           (SELECT COALESCE(SUM(reserved_cash),0) FROM limit_orders WHERE season_id=$1 AND user_id=$2 AND status='OPEN')::text AS reserved,
           (SELECT COALESCE(SUM(e.amount),0) FROM cash_ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id
             WHERE e.account_key=$3 AND t.kind IN ('SEASON_GRANT','WEEKLY_ALLOWANCE'))::text AS contributed,
           (SELECT COALESCE(SUM((p.long_qty - p.short_qty) * (mp.credit_reserve/mp.share_reserve - mp.day_open_price)),0)
              FROM positions p JOIN market_pools mp ON mp.season_id=p.season_id AND mp.stock_id=p.stock_id
             WHERE p.season_id=$1 AND p.user_id=$2)::text AS day_change`,
        [season.id, userId, accounts.userCash(userId, season.id)]
      );
      const orders = await client.query<{
        id: string; side: "BUY" | "SELL"; quantity: string; limit_price: string; reserved_cash: string; created_at: Date;
        stock_id: string; ticker: string; display_name: string;
      }>(
        `SELECT o.id,o.side,o.quantity::text,o.limit_price::text,o.reserved_cash::text,o.created_at,
                l.id AS stock_id,l.ticker::text,l.display_name
           FROM limit_orders o JOIN listings l ON l.id=o.stock_id
          WHERE o.season_id=$1 AND o.user_id=$2 AND o.status='OPEN' ORDER BY o.created_at`,
        [season.id, userId]
      );
      return { totals, figures, orders: orders.rows, positions: await positionViews(client, userId, season.id) };
    });

    const { totals, figures } = data;
    const reserved = new Decimal(figures.reserved);
    const netWorth = totals.equity.plus(reserved);
    const contributed = new Decimal(figures.contributed);
    const seasonChange = netWorth.minus(contributed);
    const dayChange = new Decimal(figures.day_change);
    const now = options.now();
    return {
      ...freshness(exchange, now),
      exchangeId: exchange.id,
      cash: money(totals.cash),
      reservedCash: money(reserved),
      netWorth: money(netWorth),
      seasonChangeAbs: money(seasonChange),
      seasonChangePct: percentOfRatio(ratio(seasonChange, contributed)),
      dayChangeAbs: money(dayChange),
      dayChangePct: percentOfRatio(ratio(dayChange, netWorth.minus(dayChange))),
      positions: data.positions,
      openOrders: data.orders.map((order) => ({
        id: order.id,
        listing: listingRef({ id: order.stock_id, ticker: order.ticker, display_name: order.display_name }),
        type: order.side === "BUY" ? "LIMIT_BUY" : "LIMIT_SELL",
        quantity: shares(order.quantity),
        triggerPrice: money(order.limit_price),
        status: "RESTING",
        reservedCash: money(order.reserved_cash),
        createdAt: isoTime(order.created_at),
        filledAt: null,
        fillPrice: null,
        rejectCode: null
      })),
      canDeclareBankruptcy: totals.equity.lt(BANKRUPTCY_EQUITY),
      nextStimulusAt: isoTime(nextWeeklyPayoutAt(exchange.timezone, now))
    };
  });
}
