import { Decimal } from "decimal.js";
import { pool, one, withTransaction } from "../db.js";
import { accounts, postLedgerTransaction } from "../core/ledger.js";
import { auraComposite, marketIndex, quoteTrade } from "../core/market.js";
import { weeklyPayoutDue } from "../core/market-hours.js";
import { engineTick, purgeOldEngineTicks } from "./engine-tick.js";
import { resolveExpiredAuraFarming } from "../services/aura-farming-service.js";
import { processOpenLimitOrders } from "../services/limit-order-service.js";
import { terminateOpenLimitOrders } from "../services/limit-order-lifecycle.js";
import { notifyUser } from "../services/notification-service.js";
import { settleExpiredOptions, settleSeasonDerivatives } from "../services/derivatives-service.js";
import { purgeExpiredKeys } from "../services/idempotency-service.js";
import { activeSeason, requireActiveSeason } from "../services/exchange-service.js";

// The worker's scheduled jobs. Exchange-owned jobs take the exchange and only ever touch its rows.

/** Calendar parts of `date` in an exchange's timezone. */
export function zonedParts(timeZone: string, date = new Date()): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export async function runOnce(key: string, work: () => Promise<void>): Promise<void> {
  const inserted = await pool.query(
    "INSERT INTO scheduled_runs(key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key", [key]
  );
  if (!inserted.rowCount) return;
  try {
    await work();
  } catch (error) {
    await pool.query("DELETE FROM scheduled_runs WHERE key=$1", [key]);
    throw error;
  }
}

export async function grantAllowance(exchangeId: string, dateKey: string): Promise<void> {
  await withTransaction(async (client) => {
    const season = await requireActiveSeason(client, exchangeId);
    const users = await client.query<{ id: string }>(
      "SELECT u.id FROM users u JOIN listings ps ON ps.owner_user_id=u.id AND ps.exchange_id=$1 WHERE ps.is_active=true", [exchangeId]
    );
    for (const user of users.rows) {
      await postLedgerTransaction(client, "WEEKLY_ALLOWANCE", `Weekly allowance ${dateKey}`, [
        { accountKey: accounts.userCash(user.id, season.id), amount: 1000 },
        { accountKey: accounts.issuance(season.id), amount: -1000 }
      ], user.id);
    }
    await client.query(
      "INSERT INTO feed_events(season_id, kind, payload) VALUES ($1,'ALLOWANCE', $2)",
      [season.id, JSON.stringify({ amount: 1000, date: dateKey })]
    );
  });
}

export async function settleDividends(exchangeId: string, dateKey: string): Promise<void> {
  await withTransaction(async (client) => {
    const season = await requireActiveSeason(client, exchangeId);
    const stocks = await client.query<{ id: string; aura_delta: string }>(
      `SELECT ps.id, COALESCE(SUM(a.delta) FILTER (WHERE a.created_at>=now()-interval '7 days'),0)::int AS aura_delta
         FROM listings ps LEFT JOIN aura_ledger_entries a ON a.stock_id=ps.id AND a.season_id=$1
        WHERE ps.is_active=true AND ps.exchange_id=$2 GROUP BY ps.id`, [season.id, exchangeId]
    );
    for (const stock of stocks.rows) {
      const perShare = new Decimal(Math.max(0, Number(stock.aura_delta))).mul("0.25");
      await client.query(
        `INSERT INTO dividend_settlements(season_id, stock_id, period_start, period_end, aura_delta, amount_per_share)
         VALUES ($1,$2,now()-interval '7 days',now(),$3,$4)`,
        [season.id, stock.id, stock.aura_delta, perShare.toFixed(8)]
      );
      if (perShare.isZero()) continue;
      const positions = await client.query<{ user_id: string; long_qty: string; short_qty: string; short_proceeds:string; short_collateral:string }>(
        "SELECT user_id,long_qty::text,short_qty::text,short_proceeds::text,short_collateral::text FROM positions WHERE season_id=$1 AND stock_id=$2", [season.id, stock.id]
      );
      for (const position of positions.rows) {
        const longAmount = perShare.mul(position.long_qty);
        if (longAmount.gt(0)) {
          await postLedgerTransaction(client, "DIVIDEND", `Aura dividend ${dateKey}`, [
            { accountKey: accounts.userCash(position.user_id, season.id), amount: longAmount },
            { accountKey: accounts.issuance(season.id), amount: longAmount.negated() }
          ], stock.id);
        }
        const shortAmount = perShare.mul(position.short_qty);
        const shortCharge=Decimal.min(shortAmount,new Decimal(position.short_proceeds).plus(position.short_collateral));
        if (shortCharge.gt(0)) {
          await postLedgerTransaction(client, "DIVIDEND_OWED", `Short dividend owed ${dateKey}`, [
            { accountKey: accounts.shortEscrow(position.user_id, stock.id, season.id), amount: shortCharge.negated() },
            { accountKey: accounts.issuance(season.id), amount: shortCharge }
          ], stock.id);
          await client.query(
            `UPDATE positions SET
               short_proceeds=short_proceeds-GREATEST(0,$1-short_collateral),
               short_collateral=GREATEST(0,short_collateral-$1),updated_at=now()
              WHERE season_id=$2 AND stock_id=$3 AND user_id=$4`, [shortCharge.toFixed(8), season.id, stock.id, position.user_id]
          );
        }
      }
    }
  });
}

export async function chargeBorrowFees(exchangeId: string, dateKey: string): Promise<void> {
  await withTransaction(async (client) => {
    const rows = await client.query<{
      id: string; season_id: string; user_id: string; stock_id: string; short_qty: string; short_collateral: string; short_proceeds: string; price: string;
    }>(
      `SELECT p.id,p.season_id,p.user_id,p.stock_id,p.short_qty::text,p.short_collateral::text,p.short_proceeds::text,
              (mp.credit_reserve/mp.share_reserve)::text AS price
         FROM positions p JOIN seasons s ON s.id=p.season_id AND s.status='ACTIVE'
         JOIN market_pools mp ON mp.season_id=p.season_id AND mp.stock_id=p.stock_id WHERE p.short_qty>0 AND p.exchange_id=$1`,
      [exchangeId]
    );
    for (const row of rows.rows) {
      const available = new Decimal(row.short_collateral).plus(row.short_proceeds);
      const fee = Decimal.min(available, new Decimal(row.short_qty).mul(row.price).mul("0.001"));
      if (fee.lte(0)) continue;
      await postLedgerTransaction(client, "BORROW_FEE", `Daily short borrow fee ${dateKey}`, [
        { accountKey: accounts.shortEscrow(row.user_id, row.stock_id, row.season_id), amount: fee.negated() },
        { accountKey: accounts.fees(row.season_id), amount: fee }
      ], row.id);
      await client.query(
        `UPDATE positions SET short_proceeds=short_proceeds-GREATEST(0,$1-short_collateral),
           short_collateral=GREATEST(0,short_collateral-$1),updated_at=now() WHERE id=$2`, [fee.toFixed(8), row.id]
      );
    }
  });
}

export async function liquidateUnsafeShorts(): Promise<void> {
  const candidates = await pool.query<{ id: string }>(
    `SELECT p.id FROM positions p JOIN seasons s ON s.id=p.season_id AND s.status='ACTIVE'
      WHERE p.short_qty>0 ORDER BY p.updated_at LIMIT 25`
  );
  for (const candidate of candidates.rows) {
    await withTransaction(async (client) => {
      const position = await one<{
        id:string;exchange_id:string;season_id:string;user_id:string;stock_id:string;short_qty:string;short_proceeds:string;short_collateral:string;
      }>(client,"SELECT id,exchange_id,season_id,user_id,stock_id,short_qty::text,short_proceeds::text,short_collateral::text FROM positions WHERE id=$1 FOR UPDATE",[candidate.id]);
      if (new Decimal(position.short_qty).lte(0)) return;
      const market = await one<{ id:string;share_reserve:string;credit_reserve:string }>(client,
        "SELECT id,share_reserve::text,credit_reserve::text FROM market_pools WHERE season_id=$1 AND stock_id=$2 FOR UPDATE",
        [position.season_id,position.stock_id]
      );
      const totalQty=new Decimal(position.short_qty);
      const totalAvailable=new Decimal(position.short_proceeds).plus(position.short_collateral);
      const spotLiability=totalQty.mul(new Decimal(market.credit_reserve).div(market.share_reserve));
      if (totalAvailable.div(spotLiability).gte("1.25")) return;
      const liquidationQty=Decimal.min(totalQty,new Decimal(market.share_reserve).mul("0.10"));
      const cover=quoteTrade({shareReserve:market.share_reserve,creditReserve:market.credit_reserve},"COVER",liquidationQty);
      const ratio=liquidationQty.div(totalQty);
      const allocatedProceeds=new Decimal(position.short_proceeds).mul(ratio);
      const allocatedCollateral=new Decimal(position.short_collateral).mul(ratio);
      const available=allocatedProceeds.plus(allocatedCollateral);
      const gross=new Decimal(cover.grossAmount);
      const fee=new Decimal(cover.feeAmount);
      const total=new Decimal(cover.netAmount);
      const refund=Decimal.max(0,available.minus(total));
      const insurance=Decimal.max(0,total.minus(available));
      const quoteId=crypto.randomUUID();
      const tradeId=crypto.randomUUID();
      await client.query(
        `INSERT INTO trade_quotes(id,season_id,user_id,stock_id,side,quantity,gross_amount,fee_amount,net_amount,
          execution_price,price_impact,reserve_version,expires_at,consumed_at)
         VALUES ($1,$2,$3,$4,'COVER',$5,$6,$7,$8,$9,$10,$11,now(),now())`,
        [quoteId,position.season_id,position.user_id,position.stock_id,cover.quantity,cover.grossAmount,cover.feeAmount,
          cover.netAmount,cover.executionPrice,cover.priceImpact,cover.reserveVersion]
      );
      await postLedgerTransaction(client,"LIQUIDATE","Automatic maintenance-margin liquidation",[
        {accountKey:accounts.poolCash(position.stock_id,position.season_id),amount:gross},
        {accountKey:accounts.fees(position.season_id),amount:fee},
        {accountKey:accounts.shortEscrow(position.user_id,position.stock_id,position.season_id),amount:available.negated()},
        ...(refund.gt(0)?[{accountKey:accounts.userCash(position.user_id,position.season_id),amount:refund}]:[]),
        ...(insurance.gt(0)?[{accountKey:accounts.issuance(position.season_id),amount:insurance.negated()}]:[])
      ],tradeId);
      await client.query(
        `INSERT INTO trades(id,season_id,user_id,stock_id,quote_id,idempotency_key,side,quantity,gross_amount,fee_amount,execution_price)
         VALUES ($1,$2,$3,$4,$5,$6,'LIQUIDATE',$7,$8,$9,$10)`,
        [tradeId,position.season_id,position.user_id,position.stock_id,quoteId,`liquidate:${position.id}:${Date.now()}`,
          cover.quantity,cover.grossAmount,cover.feeAmount,cover.executionPrice]
      );
      const remainingQty=totalQty.minus(liquidationQty);
      await client.query(
        `UPDATE positions SET short_qty=$1,avg_short_entry=CASE WHEN $1::numeric=0 THEN 0 ELSE avg_short_entry END,
          short_proceeds=short_proceeds-$2,short_collateral=short_collateral-$3,updated_at=now() WHERE id=$4`,
        [remainingQty.toFixed(8),allocatedProceeds.toFixed(8),allocatedCollateral.toFixed(8),position.id]
      );
      const nextPrice = new Decimal(cover.nextCreditReserve).div(cover.nextShareReserve);
      await client.query(
        "UPDATE market_pools SET share_reserve=$1,credit_reserve=$2,organic_price=$3,ambient_deviation=0,updated_at=now() WHERE id=$4",
        [cover.nextShareReserve,cover.nextCreditReserve,nextPrice.toFixed(8),market.id]
      );
      await client.query(
        `INSERT INTO market_price_ticks(season_id,stock_id,price,cause,reference_id,is_synthetic)
         VALUES ($1,$2,$3,'TRADE',$4,false)`,
        [position.season_id,position.stock_id,nextPrice.toFixed(8),tradeId]
      );
      await client.query(
        `INSERT INTO feed_events(season_id,kind,actor_id,subject_stock_id,payload)
         VALUES ($1,'LIQUIDATION',$2,$3,$4)`,
        [position.season_id,position.user_id,position.stock_id,JSON.stringify({tradeId,quantity:cover.quantity,price:cover.executionPrice})]
      );
      await notifyUser(client,position.exchange_id,position.user_id,"SHORT_LIQUIDATED",{tradeId,stockId:position.stock_id,quantity:cover.quantity,price:cover.executionPrice});
    });
  }
}

export async function snapshotIndices(exchangeId: string): Promise<void> {
  await withTransaction(async (client) => {
    const season = await activeSeason(client, exchangeId);
    if (!season) return;
    const rows = await client.query<{ seasonal_aura: string; price: string; opening_price: string }>(
      `SELECT ps.seasonal_aura,(mp.credit_reserve/mp.share_reserve)::text AS price,mp.opening_price::text
         FROM listings ps JOIN market_pools mp ON mp.stock_id=ps.id AND mp.season_id=$1 WHERE ps.is_active=true AND ps.exchange_id=$2`, [season.id, exchangeId]
    );
    await client.query(
      "INSERT INTO index_snapshots(season_id,aura_composite,market_index) VALUES ($1,$2,$3)",
      [season.id, auraComposite(rows.rows.map((row) => Number(row.seasonal_aura) - 100)), marketIndex(rows.rows.map((row) => new Decimal(row.price).div(row.opening_price)))]
    );
  });
}

export async function closeExpiredSeason(exchangeId: string): Promise<void> {
  await withTransaction(async (client) => {
    const expired = await client.query<{ id: string; season_number: number; exchange_id: string }>(
      "SELECT id,season_number,exchange_id FROM seasons WHERE exchange_id=$1 AND status='ACTIVE' AND ends_at<=now() FOR UPDATE",
      [exchangeId]
    );
    const old = expired.rows[0];
    if (!old) return;
    await terminateOpenLimitOrders(client, "season_id=$1", [old.id], "SEASON_CLOSED", "Limit order released at season close");
    await settleSeasonDerivatives(client,old.id);
    const standings = await client.query(
      `WITH balances AS (
         SELECT split_part(account_key,':',2)::uuid AS user_id,SUM(amount) AS cash
           FROM cash_ledger_entries WHERE account_key LIKE 'USER:%:CASH:'||$1::uuid::text GROUP BY 1
       ), exposure AS (
         SELECT p.user_id,SUM(p.long_qty*(mp.credit_reserve/mp.share_reserve)+p.short_proceeds+p.short_collateral-p.short_qty*(mp.credit_reserve/mp.share_reserve)) AS value
           FROM positions p JOIN market_pools mp ON mp.season_id=p.season_id AND mp.stock_id=p.stock_id
          WHERE p.season_id=$1 GROUP BY p.user_id
       )
       SELECT u.id,ps.display_name,ps.ticker::text,ps.seasonal_aura::text,
              (COALESCE(b.cash,0)+COALESCE(e.value,0))::text AS net_worth
         FROM users u JOIN listings ps ON ps.owner_user_id=u.id AND ps.exchange_id=$2
         LEFT JOIN balances b ON b.user_id=u.id LEFT JOIN exposure e ON e.user_id=u.id
        WHERE ps.is_active=true ORDER BY COALESCE(b.cash,0)+COALESCE(e.value,0) DESC`, [old.id, exchangeId]
    );
    await client.query("INSERT INTO season_results(season_id,snapshot) VALUES ($1,$2) ON CONFLICT(season_id) DO NOTHING",[old.id,JSON.stringify({standings:standings.rows})]);
    const closingPositions=await client.query<{id:string;user_id:string;stock_id:string;long_qty:string;short_qty:string;short_proceeds:string;short_collateral:string;price:string}>(
      `SELECT p.id,p.user_id,p.stock_id,p.long_qty::text,p.short_qty::text,p.short_proceeds::text,p.short_collateral::text,
              (mp.credit_reserve/mp.share_reserve)::text AS price
         FROM positions p JOIN market_pools mp ON mp.season_id=p.season_id AND mp.stock_id=p.stock_id
        WHERE p.season_id=$1 AND (p.long_qty>0 OR p.short_qty>0) FOR UPDATE OF p`,[old.id]
    );
    for(const position of closingPositions.rows){
      const price=new Decimal(position.price),longValue=price.mul(position.long_qty);
      if(longValue.gt(0))await postLedgerTransaction(client,"SEASON_LONG_SETTLEMENT","Long position settled at season close",[
        {accountKey:accounts.userCash(position.user_id,old.id),amount:longValue},
        {accountKey:accounts.issuance(old.id),amount:longValue.negated()}
      ],position.id);
      const available=new Decimal(position.short_proceeds).plus(position.short_collateral),liability=price.mul(position.short_qty);
      if(available.gt(0)){
        const refund=Decimal.max(0,available.minus(liability));
        const absorbed=available.minus(refund);
        await postLedgerTransaction(client,"SEASON_SHORT_SETTLEMENT","Short position settled at season close",[
          {accountKey:accounts.shortEscrow(position.user_id,position.stock_id,old.id),amount:available.negated()},
          ...(refund.gt(0)?[{accountKey:accounts.userCash(position.user_id,old.id),amount:refund}]:[]),
          ...(absorbed.gt(0)?[{accountKey:accounts.issuance(old.id),amount:absorbed}]:[])
        ],position.id);
      }
      await client.query(`UPDATE positions SET long_qty=0,avg_long_cost=0,short_qty=0,avg_short_entry=0,short_proceeds=0,short_collateral=0,updated_at=now() WHERE id=$1`,[position.id]);
    }
    await client.query("UPDATE seasons SET status='CLOSED',closed_at=now() WHERE id=$1", [old.id]);
    const next = await one<{ id: string }>(client,
      `INSERT INTO seasons(exchange_id,season_number,name,starts_at,ends_at) VALUES ($1,$2,$3,now(),now()+interval '8 weeks') RETURNING id`,
      [old.exchange_id, old.season_number + 1, `Season ${old.season_number + 1}`]
    );
    await client.query("UPDATE listings SET seasonal_aura=100 WHERE is_active=true AND exchange_id=$1", [exchangeId]);
    const users = await client.query<{ user_id: string; stock_id: string }>(
      "SELECT owner_user_id AS user_id,id AS stock_id FROM listings WHERE is_active=true AND owner_user_id IS NOT NULL AND exchange_id=$1",
      [exchangeId]
    );
    for (const user of users.rows) {
      await client.query("INSERT INTO market_pools(season_id,stock_id) VALUES ($1,$2)", [next.id, user.stock_id]);
      await postLedgerTransaction(client, "SEASON_GRANT", "New season balance", [
        { accountKey: accounts.userCash(user.user_id, next.id), amount: 10_000 },
        { accountKey: accounts.issuance(next.id), amount: -10_000 }
      ], user.user_id);
    }
    await client.query("INSERT INTO feed_events(season_id,kind,payload) VALUES ($1,'SEASON_STARTED',$2)", [next.id, JSON.stringify({ seasonNumber: old.season_number + 1 })]);
  });
}

export interface ExchangeClock {
  id: string;
  timezone: string;
}

/** Jobs that work row by row and never mix exchanges inside one transaction. */
export async function runServerSchedulers(now = Date.now()): Promise<void> {
  const motionKey = Math.floor(now / 15_000);
  const minuteKey = Math.floor(now / 60_000);
  const hourKey = Math.floor(now / 3_600_000);
  await runOnce(`limit-orders:${motionKey}`, processOpenLimitOrders);
  await runOnce(`liquidations:${minuteKey}`, liquidateUnsafeShorts);
  await runOnce(`aura-farming:${minuteKey}`, resolveExpiredAuraFarming);
  await runOnce(`option-settlement:${minuteKey}`, settleExpiredOptions);
  await runOnce(`idempotency-purge:${hourKey}`, async () => { await purgeExpiredKeys(pool); });
  await runOnce(`engine-tick-purge:${hourKey}`, async () => { await purgeOldEngineTicks(); });
  await runOnce(`scheduled-runs-purge:${hourKey}`, async () => {
    await pool.query("DELETE FROM scheduled_runs WHERE completed_at < now() - interval '7 days'");
  });
}

/** Jobs that belong to one exchange, run on its own clock. Run-once keys carry the exchange id. */
export async function runExchangeSchedulers(exchange: ExchangeClock, now = new Date()): Promise<void> {
  const parts = zonedParts(exchange.timezone, now);
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const fiveMinuteKey = Math.floor(now.getTime() / 300_000);
  const motionKey = Math.floor(now.getTime() / 15_000);
  const key = (name: string, period: string | number) => `${name}:${exchange.id}:${period}`;
  await runOnce(key("engine-tick", motionKey), async () => { await engineTick(exchange.id, now); });
  await runOnce(key("indices", fiveMinuteKey), () => snapshotIndices(exchange.id));
  await runOnce(key("season-check", `${dateKey}:${parts.hour}`), () => closeExpiredSeason(exchange.id));
  if (!(await activeSeason(pool, exchange.id))) return;
  if (weeklyPayoutDue(exchange.timezone, now)) {
    await runOnce(key("allowance", dateKey), () => grantAllowance(exchange.id, dateKey));
    await runOnce(key("dividends", dateKey), () => settleDividends(exchange.id, dateKey));
  }
  await runOnce(key("borrow-fees", dateKey), () => chargeBorrowFees(exchange.id, dateKey));
  await runOnce(key("market-open", dateKey), async () => {
    await pool.query(
      `UPDATE market_pools SET day_open_price=credit_reserve/share_reserve, halted_until=NULL
        WHERE exchange_id=$1 AND season_id IN (SELECT id FROM seasons WHERE exchange_id=$1 AND status='ACTIVE')
          AND halted_until IS DISTINCT FROM 'infinity'`,
      [exchange.id]
    );
  });
}

/**
 * One failing job is logged and retried on the next loop (runOnce releases its key); it never stops the
 * worker or another exchange's schedule.
 */
export async function runSchedulers(): Promise<void> {
  try {
    await runServerSchedulers();
  } catch (error) {
    console.error("Server-wide scheduled job failed", error);
  }
  const exchanges = await pool.query<ExchangeClock>("SELECT id,timezone FROM exchanges ORDER BY created_at");
  for (const exchange of exchanges.rows) {
    try {
      await runExchangeSchedulers(exchange);
    } catch (error) {
      console.error(`Scheduled job failed for exchange ${exchange.id}`, error);
    }
  }
}
