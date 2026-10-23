import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { guard } from "../auth.js";
import { one, maybeOne, withTransaction } from "../db.js";
import { accounts, accountBalance, postLedgerTransaction } from "../core/ledger.js";
import { quoteTrade, reserveVersion, spotPrice } from "../core/market.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { portfolioTotals } from "../services/portfolio-service.js";
import type { TradeSide } from "../types.js";

const quoteInput = z.object({
  stockId: z.string().uuid(),
  side: z.enum(["BUY", "SELL", "SHORT", "COVER"]),
  quantity: z.coerce.number().positive().max(100_000)
});

interface PoolRow {
  id: string;
  season_id: string;
  stock_id: string;
  share_reserve: string;
  credit_reserve: string;
  day_open_price: string;
  halted_until: Date | null;
}

interface PositionRow {
  id: string;
  long_qty: string;
  avg_long_cost: string;
  short_qty: string;
  avg_short_entry: string;
  short_proceeds: string;
  short_collateral: string;
  realized_pnl: string;
}

async function loadPosition(client: PoolClient, userId: string, stockId: string, seasonId: string, lock = false): Promise<PositionRow> {
  await client.query(
    `INSERT INTO positions(season_id, user_id, stock_id) VALUES ($1,$2,$3)
     ON CONFLICT (season_id, user_id, stock_id) DO NOTHING`, [seasonId, userId, stockId]
  );
  return one<PositionRow>(client,
    `SELECT * FROM positions WHERE season_id = $1 AND user_id = $2 AND stock_id = $3 ${lock ? "FOR UPDATE" : ""}`,
    [seasonId, userId, stockId]
  );
}

async function validateOrder(
  client: PoolClient,
  userId: string,
  stockId: string,
  side: TradeSide,
  quote: ReturnType<typeof quoteTrade>,
  position: PositionRow,
  seasonId: string
): Promise<void> {
  const quantity = new Decimal(quote.quantity);
  const cash = await accountBalance(client, accounts.userCash(userId, seasonId));
  if (side === "BUY") {
    if (new Decimal(position.short_qty).gt(0)) throw conflict("Cover your short before buying long");
    if (cash.lt(quote.netAmount)) throw badRequest("Insufficient Aura Credits", "INSUFFICIENT_FUNDS");
  }
  if (side === "SELL" && new Decimal(position.long_qty).lt(quantity)) {
    throw badRequest("You do not own enough shares", "INSUFFICIENT_SHARES");
  }
  if (side === "SHORT") {
    if (new Decimal(position.long_qty).gt(0)) throw conflict("Sell your long position before shorting");
    const totals = await portfolioTotals(client, userId, seasonId);
    const notional = new Decimal(quote.grossAmount);
    const margin = notional.mul("0.50");
    if (cash.lt(margin)) throw badRequest("Insufficient collateral", "INSUFFICIENT_COLLATERAL");
    const stockExposure = new Decimal(position.short_qty).mul(quote.currentPrice).plus(notional);
    if (stockExposure.gt(totals.equity.mul("0.20"))) throw badRequest("Per-stock short cap is 20% of portfolio equity", "SHORT_CAP");
    if (totals.shortLiability.plus(notional).gt(totals.equity.mul("0.50"))) throw badRequest("Total short cap is 50% of portfolio equity", "SHORT_CAP");
  }
  if (side === "COVER") {
    if (new Decimal(position.short_qty).lt(quantity)) throw badRequest("Cover quantity exceeds your short", "INVALID_COVER");
    const ratio = quantity.div(position.short_qty);
    const available = new Decimal(position.short_proceeds).plus(position.short_collateral).mul(ratio);
    const deficit = new Decimal(quote.netAmount).minus(available);
    if (deficit.gt(0) && cash.lt(deficit)) throw badRequest("Insufficient cash to cover this short", "INSUFFICIENT_FUNDS");
  }
}

export async function registerTradeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/trades/quote", { preHandler: guard({ csrf: true }) }, async (request, reply) => {
    const input = quoteInput.parse(request.body);
    const auth = request.auth!;
    if (auth.stockId === input.stockId) throw forbidden("You cannot trade your own Aura stock");

    const saved = await withTransaction(async (client) => {
      const pool = await maybeOne<PoolRow>(client,
        `SELECT mp.* FROM market_pools mp JOIN seasons s ON s.id = mp.season_id
          JOIN person_stocks ps ON ps.id = mp.stock_id
         WHERE mp.stock_id = $1 AND s.status = 'ACTIVE' AND ps.is_active = true`, [input.stockId]
      );
      if (!pool) throw notFound("Market not found");
      if (pool.halted_until && pool.halted_until > new Date()) throw conflict("This market is temporarily halted", "MARKET_HALTED");
      const position = await loadPosition(client, auth.id, input.stockId, pool.season_id);
      const quote = quoteTrade({ shareReserve: pool.share_reserve, creditReserve: pool.credit_reserve }, input.side, input.quantity);
      await validateOrder(client, auth.id, input.stockId, input.side, quote, position, pool.season_id);
      const id = randomUUID();
      await client.query(
        `INSERT INTO trade_quotes(id, season_id, user_id, stock_id, side, quantity, gross_amount, fee_amount,
          net_amount, execution_price, price_impact, reserve_version, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now() + interval '15 seconds')`,
        [id, pool.season_id, auth.id, input.stockId, input.side, quote.quantity, quote.grossAmount,
          quote.feeAmount, quote.netAmount, quote.executionPrice, quote.priceImpact, quote.reserveVersion]
      );
      return { id, expiresInSeconds: 15, ...quote };
    });
    reply.code(201);
    return saved;
  });

  app.post("/api/trades/execute", { preHandler: guard({ csrf: true }) }, async (request, reply) => {
    const input = z.object({ quoteId: z.string().uuid(), idempotencyKey: z.string().min(8).max(100) }).parse(request.body);
    const auth = request.auth!;
    const executed = await withTransaction(async (client) => {
      const duplicate = await maybeOne<{ id: string }>(client,
        "SELECT id FROM trades WHERE user_id = $1 AND idempotency_key = $2", [auth.id, input.idempotencyKey]
      );
      if (duplicate) return { tradeId: duplicate.id, duplicate: true };

      const quote = await maybeOne<{
        id: string; season_id: string; user_id: string; stock_id: string; side: TradeSide; quantity: string;
        gross_amount: string; fee_amount: string; net_amount: string; execution_price: string;
        reserve_version: string; expires_at: Date; consumed_at: Date | null;
      }>(client, "SELECT * FROM trade_quotes WHERE id = $1 FOR UPDATE", [input.quoteId]);
      if (!quote || quote.user_id !== auth.id) throw notFound("Quote not found");
      if (quote.consumed_at) throw conflict("Quote has already been used", "QUOTE_USED");
      if (quote.expires_at < new Date()) throw conflict("Quote expired; request a new one", "QUOTE_EXPIRED");

      const market = await one<PoolRow>(client, "SELECT * FROM market_pools WHERE season_id = $1 AND stock_id = $2 FOR UPDATE", [quote.season_id, quote.stock_id]);
      if (market.halted_until && market.halted_until > new Date()) throw conflict("This market is temporarily halted", "MARKET_HALTED");
      if (reserveVersion({ shareReserve: market.share_reserve, creditReserve: market.credit_reserve }) !== quote.reserve_version) {
        throw conflict("Market moved; request a fresh quote", "STALE_QUOTE");
      }
      const calculated = quoteTrade({ shareReserve: market.share_reserve, creditReserve: market.credit_reserve }, quote.side, quote.quantity);
      const position = await loadPosition(client, auth.id, quote.stock_id, quote.season_id, true);
      await validateOrder(client, auth.id, quote.stock_id, quote.side, calculated, position, quote.season_id);

      const tradeId = randomUUID();
      const qty = new Decimal(calculated.quantity);
      const gross = new Decimal(calculated.grossAmount);
      const fee = new Decimal(calculated.feeAmount);
      const net = new Decimal(calculated.netAmount);
      const userCash = accounts.userCash(auth.id, quote.season_id);
      const poolCash = accounts.poolCash(quote.stock_id, quote.season_id);
      const feeAccount = accounts.fees(quote.season_id);
      const escrow = accounts.shortEscrow(auth.id, quote.stock_id, quote.season_id);

      if (quote.side === "BUY") {
        const oldQty = new Decimal(position.long_qty);
        const newQty = oldQty.plus(qty);
        const avg = oldQty.mul(position.avg_long_cost).plus(net).div(newQty);
        await postLedgerTransaction(client, "BUY", `Buy ${qty.toString()} shares`, [
          { accountKey: userCash, amount: net.negated() }, { accountKey: poolCash, amount: gross }, { accountKey: feeAccount, amount: fee }
        ], tradeId);
        await client.query("UPDATE positions SET long_qty=$1, avg_long_cost=$2, updated_at=now() WHERE id=$3", [newQty.toFixed(8), avg.toFixed(8), position.id]);
      } else if (quote.side === "SELL") {
        const newQty = new Decimal(position.long_qty).minus(qty);
        const realized = new Decimal(calculated.executionPrice).minus(position.avg_long_cost).mul(qty).minus(fee);
        await postLedgerTransaction(client, "SELL", `Sell ${qty.toString()} shares`, [
          { accountKey: poolCash, amount: gross.negated() }, { accountKey: userCash, amount: net }, { accountKey: feeAccount, amount: fee }
        ], tradeId);
        await client.query(
          "UPDATE positions SET long_qty=$1, avg_long_cost=$2, realized_pnl=realized_pnl+$3, updated_at=now() WHERE id=$4",
          [newQty.toFixed(8), newQty.isZero() ? 0 : position.avg_long_cost, realized.toFixed(8), position.id]
        );
      } else if (quote.side === "SHORT") {
        const margin = gross.mul("0.50");
        const oldQty = new Decimal(position.short_qty);
        const newQty = oldQty.plus(qty);
        const avg = oldQty.mul(position.avg_short_entry).plus(gross).div(newQty);
        await postLedgerTransaction(client, "SHORT", `Short ${qty.toString()} shares`, [
          { accountKey: poolCash, amount: gross.negated() }, { accountKey: userCash, amount: margin.negated() },
          { accountKey: escrow, amount: net.plus(margin) }, { accountKey: feeAccount, amount: fee }
        ], tradeId);
        await client.query(
          `UPDATE positions SET short_qty=$1, avg_short_entry=$2, short_proceeds=short_proceeds+$3,
             short_collateral=short_collateral+$4, updated_at=now() WHERE id=$5`,
          [newQty.toFixed(8), avg.toFixed(8), net.toFixed(8), margin.toFixed(8), position.id]
        );
      } else {
        const oldQty = new Decimal(position.short_qty);
        const ratio = qty.div(oldQty);
        const allocatedProceeds = new Decimal(position.short_proceeds).mul(ratio);
        const allocatedCollateral = new Decimal(position.short_collateral).mul(ratio);
        const available = allocatedProceeds.plus(allocatedCollateral);
        const userDifference = available.minus(net);
        const newQty = oldQty.minus(qty);
        const realized = allocatedProceeds.minus(gross).minus(fee);
        await postLedgerTransaction(client, "COVER", `Cover ${qty.toString()} shares`, [
          { accountKey: poolCash, amount: gross }, { accountKey: feeAccount, amount: fee },
          { accountKey: escrow, amount: available.negated() }, { accountKey: userCash, amount: userDifference }
        ], tradeId);
        await client.query(
          `UPDATE positions SET short_qty=$1, avg_short_entry=$2, short_proceeds=short_proceeds-$3,
             short_collateral=short_collateral-$4, realized_pnl=realized_pnl+$5, updated_at=now() WHERE id=$6`,
          [newQty.toFixed(8), newQty.isZero() ? 0 : position.avg_short_entry, allocatedProceeds.toFixed(8),
            allocatedCollateral.toFixed(8), realized.toFixed(8), position.id]
        );
      }

      const nextPrice = new Decimal(calculated.nextCreditReserve).div(calculated.nextShareReserve);
      const dayMove = nextPrice.div(market.day_open_price).minus(1).abs();
      await client.query(
        `UPDATE market_pools SET share_reserve=$1, credit_reserve=$2,
           halted_until=CASE WHEN $3::numeric >= 0.35 THEN now() + interval '30 minutes' ELSE halted_until END,
           updated_at=now() WHERE id=$4`,
        [calculated.nextShareReserve, calculated.nextCreditReserve, dayMove.toFixed(8), market.id]
      );
      await client.query(
        `INSERT INTO trades(id, season_id, user_id, stock_id, quote_id, idempotency_key, side, quantity, gross_amount, fee_amount, execution_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [tradeId, quote.season_id, auth.id, quote.stock_id, quote.id, input.idempotencyKey, quote.side,
          calculated.quantity, calculated.grossAmount, calculated.feeAmount, calculated.executionPrice]
      );
      await client.query("UPDATE trade_quotes SET consumed_at=now() WHERE id=$1", [quote.id]);
      await client.query(
        `INSERT INTO feed_events(season_id, kind, actor_id, subject_stock_id, payload)
         VALUES ($1, 'TRADE', $2, $3, $4)`,
        [quote.season_id, auth.id, quote.stock_id, JSON.stringify({ tradeId, side: quote.side, quantity: calculated.quantity, price: calculated.executionPrice })]
      );
      return { tradeId, duplicate: false, side: quote.side, quantity: calculated.quantity, executionPrice: calculated.executionPrice };
    });
    reply.code(executed.duplicate ? 200 : 201);
    return executed;
  });

  app.post("/api/positions/:id/close", { preHandler: guard({ csrf: true }) }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const auth = request.auth!;
    return withTransaction(async (client) => {
      const position = await maybeOne<PositionRow & { stock_id: string; season_id: string }>(client,
        "SELECT * FROM positions WHERE id=$1 AND user_id=$2", [params.id, auth.id]
      );
      if (!position) throw notFound("Position not found");
      const side: TradeSide = new Decimal(position.long_qty).gt(0) ? "SELL" : "COVER";
      const quantity = side === "SELL" ? position.long_qty : position.short_qty;
      if (new Decimal(quantity).lte(0)) throw badRequest("Position is already closed");
      const market = await one<PoolRow>(client, "SELECT * FROM market_pools WHERE season_id=$1 AND stock_id=$2", [position.season_id, position.stock_id]);
      const calculated = quoteTrade({ shareReserve: market.share_reserve, creditReserve: market.credit_reserve }, side, quantity);
      await validateOrder(client, auth.id, position.stock_id, side, calculated, position, position.season_id);
      const id = randomUUID();
      await client.query(
        `INSERT INTO trade_quotes(id, season_id, user_id, stock_id, side, quantity, gross_amount, fee_amount,
          net_amount, execution_price, price_impact, reserve_version, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now() + interval '15 seconds')`,
        [id, position.season_id, auth.id, position.stock_id, side, calculated.quantity, calculated.grossAmount,
          calculated.feeAmount, calculated.netAmount, calculated.executionPrice, calculated.priceImpact, calculated.reserveVersion]
      );
      return { quoteId: id, expiresInSeconds: 15, ...calculated };
    });
  });
}

