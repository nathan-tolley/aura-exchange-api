import { Decimal } from "decimal.js";
import type { Pool, PoolClient } from "pg";
import { MAINTENANCE_COLLATERAL, WARNING_COLLATERAL } from "../core/market.js";
import { BORROW_FEE_DAILY } from "../services/market-data-service.js";
import { isoTime, money, percentOfRatio, shares } from "./serialize.js";
import { listingRef } from "./views.js";

type Db = Pick<Pool | PoolClient, "query">;

interface PositionViewRow {
  id: string;
  long_qty: string;
  avg_long_cost: string;
  short_qty: string;
  avg_short_entry: string;
  short_proceeds: string;
  short_collateral: string;
  listing_id: string;
  ticker: string;
  display_name: string;
  share_reserve: string;
  credit_reserve: string;
  opened_at: Date | null;
  updated_at: Date;
}

/** The price at which a short's collateral falls to the 125% maintenance level and it is liquidated. */
export const liquidationPrice = (escrow: Decimal, shortQuantity: Decimal) => escrow.div(MAINTENANCE_COLLATERAL.mul(shortQuantity));

function positionView(row: PositionViewRow) {
  const price = new Decimal(row.credit_reserve).div(row.share_reserve);
  const isLong = new Decimal(row.long_qty).gt(0);
  const quantity = new Decimal(isLong ? row.long_qty : row.short_qty);
  const average = new Decimal(isLong ? row.avg_long_cost : row.avg_short_entry);
  const pnl = isLong ? price.minus(average).mul(quantity) : average.minus(price).mul(quantity);
  const basis = average.mul(quantity);
  const escrow = new Decimal(row.short_proceeds).plus(row.short_collateral);
  return {
    id: row.id,
    listing: listingRef({ id: row.listing_id, ticker: row.ticker, display_name: row.display_name }),
    side: isLong ? "LONG" : "SHORT",
    status: "OPEN",
    quantity: shares(quantity),
    avgPrice: money(average),
    marketPrice: money(price),
    marketValue: money(isLong ? price.mul(quantity) : price.mul(quantity).negated()),
    unrealizedPnl: money(pnl),
    unrealizedPnlPct: percentOfRatio(basis.isZero() ? 0 : pnl.div(basis)),
    short: isLong ? null : {
      collateral: money(escrow),
      collateralRatioPct: percentOfRatio(escrow.div(price.mul(quantity))),
      warningRatioPct: percentOfRatio(WARNING_COLLATERAL),
      maintenanceRatioPct: percentOfRatio(MAINTENANCE_COLLATERAL),
      liquidationPrice: money(liquidationPrice(escrow, quantity)),
      borrowFeeDailyPct: percentOfRatio(BORROW_FEE_DAILY)
    },
    openedAt: isoTime(row.opened_at ?? row.updated_at),
    closedAt: null
  };
}

/** The user's open positions this season (or the one on a listing), marked at the pool price. */
export async function positionViews(db: Db, userId: string, seasonId: string, listingId?: string) {
  const result = await db.query<PositionViewRow>(
    `SELECT p.id, p.long_qty::text, p.avg_long_cost::text, p.short_qty::text, p.avg_short_entry::text,
            p.short_proceeds::text, p.short_collateral::text, p.updated_at,
            l.id AS listing_id, l.ticker::text, l.display_name, mp.share_reserve::text, mp.credit_reserve::text,
            (SELECT MIN(t.created_at) FROM trades t WHERE t.season_id=p.season_id AND t.user_id=p.user_id AND t.stock_id=p.stock_id) AS opened_at
       FROM positions p
       JOIN listings l ON l.id=p.stock_id
       JOIN market_pools mp ON mp.season_id=p.season_id AND mp.stock_id=p.stock_id
      WHERE p.user_id=$1 AND p.season_id=$2 AND (p.long_qty>0 OR p.short_qty>0) AND ($3::uuid IS NULL OR p.stock_id=$3)
      ORDER BY l.ticker`,
    [userId, seasonId, listingId ?? null]
  );
  return result.rows.map(positionView);
}
