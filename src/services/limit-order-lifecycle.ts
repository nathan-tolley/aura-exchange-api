import { Decimal } from "decimal.js";
import type { PoolClient } from "pg";
import { accounts, postLedgerTransaction } from "../core/ledger.js";

export type LimitOrderTerminalStatus = "CANCELED" | "EXPIRED" | "DELISTED" | "SEASON_CLOSED";

export async function terminateOpenLimitOrders(
  client: PoolClient,
  whereSql: string,
  whereValues: unknown[],
  status: LimitOrderTerminalStatus,
  reason: string
): Promise<number> {
  const orders = await client.query<{ id:string;season_id:string;user_id:string;side:"BUY"|"SELL";reserved_cash:string }>(
    `SELECT id,season_id,user_id,side,reserved_cash::text FROM limit_orders WHERE status='OPEN' AND (${whereSql}) FOR UPDATE`,
    whereValues
  );
  for (const order of orders.rows) {
    const reserved = new Decimal(order.reserved_cash);
    if (order.side === "BUY" && reserved.gt(0)) {
      await postLedgerTransaction(client, `LIMIT_${status}`, reason, [
        { accountKey: accounts.limitEscrow(order.id, order.season_id), amount: reserved.negated() },
        { accountKey: accounts.userCash(order.user_id, order.season_id), amount: reserved }
      ], order.id);
    }
    await client.query(
      `UPDATE limit_orders SET status=$1,canceled_at=now(),updated_at=now() WHERE id=$2 AND status='OPEN'`,
      [status, order.id]
    );
  }
  return orders.rowCount ?? 0;
}
