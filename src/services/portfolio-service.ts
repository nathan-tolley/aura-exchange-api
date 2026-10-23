import type { PoolClient } from "pg";
import { Decimal } from "decimal.js";
import { accountBalance, accounts } from "../core/ledger.js";

export interface PortfolioTotals {
  cash: Decimal;
  longValue: Decimal;
  shortLiability: Decimal;
  shortEscrow: Decimal;
  equity: Decimal;
}

export async function portfolioTotals(client: PoolClient, userId: string, seasonId: string): Promise<PortfolioTotals> {
  const cash = await accountBalance(client, accounts.userCash(userId, seasonId));
  const result = await client.query<{
    long_qty: string;
    short_qty: string;
    short_proceeds: string;
    short_collateral: string;
    price: string;
  }>(
    `SELECT p.long_qty::text, p.short_qty::text, p.short_proceeds::text, p.short_collateral::text,
            (mp.credit_reserve / mp.share_reserve)::text AS price
       FROM positions p JOIN market_pools mp ON mp.stock_id = p.stock_id AND mp.season_id = p.season_id
      WHERE p.user_id = $1 AND p.season_id = $2`, [userId, seasonId]
  );
  let longValue = new Decimal(0);
  let shortLiability = new Decimal(0);
  let shortEscrow = new Decimal(0);
  for (const row of result.rows) {
    longValue = longValue.plus(new Decimal(row.long_qty).mul(row.price));
    shortLiability = shortLiability.plus(new Decimal(row.short_qty).mul(row.price));
    shortEscrow = shortEscrow.plus(row.short_proceeds).plus(row.short_collateral);
  }
  return { cash, longValue, shortLiability, shortEscrow, equity: cash.plus(longValue).plus(shortEscrow).minus(shortLiability) };
}

