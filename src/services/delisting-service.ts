import type { PoolClient } from "pg";
import { Decimal } from "decimal.js";
import { accounts, postLedgerTransaction } from "../core/ledger.js";
import { one } from "../db.js";

export async function delistStock(client: PoolClient, stockId: string, actorId: string): Promise<void> {
  const market = await one<{ id: string; season_id: string; price: string }>(client,
    `SELECT mp.id,mp.season_id,(mp.credit_reserve/mp.share_reserve)::text AS price
       FROM market_pools mp JOIN seasons s ON s.id=mp.season_id AND s.status='ACTIVE'
      WHERE mp.stock_id=$1 FOR UPDATE`, [stockId]
  );
  const price = new Decimal(market.price);
  const positions = await client.query<{
    id: string; user_id: string; long_qty: string; short_qty: string; short_proceeds: string; short_collateral: string;
  }>("SELECT id,user_id,long_qty::text,short_qty::text,short_proceeds::text,short_collateral::text FROM positions WHERE season_id=$1 AND stock_id=$2 FOR UPDATE", [market.season_id, stockId]);

  for (const position of positions.rows) {
    const longValue = price.mul(position.long_qty);
    if (longValue.gt(0)) {
      await postLedgerTransaction(client, "DELIST_LONG_SETTLEMENT", "Long position settled at pre-freeze mark", [
        { accountKey: accounts.userCash(position.user_id, market.season_id), amount: longValue },
        { accountKey: accounts.issuance(market.season_id), amount: longValue.negated() }
      ], position.id);
    }
    const available = new Decimal(position.short_proceeds).plus(position.short_collateral);
    const liability = price.mul(position.short_qty);
    if (available.gt(0)) {
      const refund = Decimal.max(0, available.minus(liability));
      await postLedgerTransaction(client, "DELIST_SHORT_SETTLEMENT", "Short position settled at pre-freeze mark", [
        { accountKey: accounts.shortEscrow(position.user_id, stockId, market.season_id), amount: available.negated() },
        ...(refund.gt(0) ? [{ accountKey: accounts.userCash(position.user_id, market.season_id), amount: refund }] : []),
        { accountKey: accounts.issuance(market.season_id), amount: available.minus(refund) }
      ], position.id);
    }
    await client.query(
      `UPDATE positions SET long_qty=0,avg_long_cost=0,short_qty=0,avg_short_entry=0,
         short_proceeds=0,short_collateral=0,updated_at=now() WHERE id=$1`, [position.id]
    );
  }
  await client.query("UPDATE market_pools SET halted_until='infinity',updated_at=now() WHERE id=$1", [market.id]);
  await client.query("UPDATE person_stocks SET is_active=false,opted_out_at=now(),updated_at=now() WHERE id=$1", [stockId]);
  await client.query("UPDATE feed_events SET hidden_at=now() WHERE subject_stock_id=$1", [stockId]);
  await client.query(
    `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata)
     VALUES ($1,'STOCK_DELISTED','PERSON_STOCK',$2,$3)`, [actorId, stockId, JSON.stringify({ settlementPrice: price.toString() })]
  );
}

