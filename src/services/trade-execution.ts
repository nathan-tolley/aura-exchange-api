import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { PoolClient } from "pg";
import { one } from "../db.js";
import { accounts, postLedgerTransaction } from "../core/ledger.js";
import { marketAuraAdjustment, type MarketQuote } from "../core/market.js";
import type { TradeSide } from "../types.js";

export interface PoolRow {
  id: string;
  season_id: string;
  stock_id: string;
  share_reserve: string;
  credit_reserve: string;
  day_open_price: string;
  halted_until: Date | null;
}

export interface PositionRow {
  id: string;
  long_qty: string;
  avg_long_cost: string;
  short_qty: string;
  avg_short_entry: string;
  short_proceeds: string;
  short_collateral: string;
  realized_pnl: string;
}

/** The user's position on a listing this season, created empty if it doesn't exist yet. */
export async function loadPosition(client: PoolClient, userId: string, stockId: string, seasonId: string, lock = false): Promise<PositionRow> {
  await client.query(
    `INSERT INTO positions(season_id, user_id, stock_id) VALUES ($1,$2,$3)
     ON CONFLICT (season_id, user_id, stock_id) DO NOTHING`, [seasonId, userId, stockId]
  );
  return one<PositionRow>(client,
    `SELECT * FROM positions WHERE season_id = $1 AND user_id = $2 AND stock_id = $3 ${lock ? "FOR UPDATE" : ""}`,
    [seasonId, userId, stockId]
  );
}

/** PLAN.md: a short puts up 50% of its value as margin, on top of the proceeds (150% collateral). */
export const SHORT_MARGIN = new Decimal("0.50");

export interface ExecuteTradeInput {
  userId: string;
  quoteId: string;
  seasonId: string;
  stockId: string;
  side: TradeSide;
  idempotencyKey: string;
  /** Locked by the caller. */
  market: Pick<PoolRow, "id" | "day_open_price">;
  /** Locked by the caller. */
  position: PositionRow;
  /** Calculated against the exact reserves the quote was made on (the caller checks the reserve version). */
  calculated: MarketQuote;
  /** The /api console still moves the person's aura on every trade; /v1 doesn't (PLAN.md drops it). */
  auraCoupling: boolean;
}

/**
 * Moves the money for a validated trade inside the caller's transaction: double-entry postings, the position,
 * the pool, the trade row, the price tick, the consumed quote and the tape line.
 */
export async function executeTrade(client: PoolClient, input: ExecuteTradeInput): Promise<{ tradeId: string; executedAt: Date; auraImpact: Decimal }> {
  const { calculated, position, market } = input;
  const tradeId = randomUUID();
  const qty = new Decimal(calculated.quantity);
  const gross = new Decimal(calculated.grossAmount);
  const fee = new Decimal(calculated.feeAmount);
  const net = new Decimal(calculated.netAmount);
  const userCash = accounts.userCash(input.userId, input.seasonId);
  const poolCash = accounts.poolCash(input.stockId, input.seasonId);
  const feeAccount = accounts.fees(input.seasonId);
  const escrow = accounts.shortEscrow(input.userId, input.stockId, input.seasonId);

  if (input.side === "BUY") {
    const oldQty = new Decimal(position.long_qty);
    const newQty = oldQty.plus(qty);
    const avg = oldQty.mul(position.avg_long_cost).plus(net).div(newQty);
    await postLedgerTransaction(client, "BUY", `Buy ${qty.toString()} shares`, [
      { accountKey: userCash, amount: net.negated() }, { accountKey: poolCash, amount: gross }, { accountKey: feeAccount, amount: fee }
    ], tradeId);
    await client.query("UPDATE positions SET long_qty=$1, avg_long_cost=$2, updated_at=now() WHERE id=$3", [newQty.toFixed(8), avg.toFixed(8), position.id]);
  } else if (input.side === "SELL") {
    const newQty = new Decimal(position.long_qty).minus(qty);
    const realized = new Decimal(calculated.executionPrice).minus(position.avg_long_cost).mul(qty).minus(fee);
    await postLedgerTransaction(client, "SELL", `Sell ${qty.toString()} shares`, [
      { accountKey: poolCash, amount: gross.negated() }, { accountKey: userCash, amount: net }, { accountKey: feeAccount, amount: fee }
    ], tradeId);
    await client.query(
      "UPDATE positions SET long_qty=$1, avg_long_cost=$2, realized_pnl=realized_pnl+$3, updated_at=now() WHERE id=$4",
      [newQty.toFixed(8), newQty.isZero() ? 0 : position.avg_long_cost, realized.toFixed(8), position.id]
    );
  } else if (input.side === "SHORT") {
    const margin = gross.mul(SHORT_MARGIN);
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
       organic_price=$4, ambient_deviation=0, updated_at=now() WHERE id=$5`,
    [calculated.nextShareReserve, calculated.nextCreditReserve, dayMove.toFixed(8), nextPrice.toFixed(8), market.id]
  );
  const trade = await one<{ created_at: Date }>(client,
    `INSERT INTO trades(id, season_id, user_id, stock_id, quote_id, idempotency_key, side, quantity, gross_amount, fee_amount, execution_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING created_at`,
    [tradeId, input.seasonId, input.userId, input.stockId, input.quoteId, input.idempotencyKey, input.side,
      calculated.quantity, calculated.grossAmount, calculated.feeAmount, calculated.executionPrice]
  );
  const auraImpact = input.auraCoupling ? marketAuraAdjustment(input.side, calculated.grossAmount) : new Decimal(0);
  if (!auraImpact.isZero()) {
    await client.query(
      `INSERT INTO aura_ledger_entries(season_id, stock_id, delta, reason, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.seasonId, input.stockId, auraImpact.toFixed(2),
        `Market confidence from ${input.side.toLowerCase()} trade ${tradeId}`, input.userId]
    );
    await client.query(
      `UPDATE listings
          SET seasonal_aura=seasonal_aura+$1, career_aura=career_aura+$1, updated_at=now()
        WHERE id=$2`,
      [auraImpact.toFixed(2), input.stockId]
    );
  }
  await client.query(
    `INSERT INTO market_price_ticks(season_id,stock_id,price,cause,reference_id,is_synthetic)
     VALUES ($1,$2,$3,'TRADE',$4,false)`,
    [input.seasonId, input.stockId, nextPrice.toFixed(8), tradeId]
  );
  await client.query("UPDATE trade_quotes SET consumed_at=now() WHERE id=$1", [input.quoteId]);
  await client.query(
    `INSERT INTO feed_events(season_id, kind, actor_id, subject_stock_id, payload)
     VALUES ($1, 'TRADE', $2, $3, $4)`,
    [input.seasonId, input.userId, input.stockId, JSON.stringify({
      tradeId,
      side: input.side,
      quantity: calculated.quantity,
      price: calculated.executionPrice,
      auraImpact: auraImpact.toNumber()
    })]
  );
  return { tradeId, executedAt: trade.created_at, auraImpact };
}
