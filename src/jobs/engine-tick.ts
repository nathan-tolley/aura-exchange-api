import { Decimal } from "decimal.js";
import { marketSession, openSecondsBetween, tradingDaySeconds } from "../core/market-hours.js";
import { one, pool, withTransaction } from "../db.js";
import { DEFAULT_ENGINE_PARAMS, tick, type DriftSlice, type EngineParams, type ListingState } from "../engine/engine.js";
import { seededRng } from "../engine/rng.js";
import { type ExchangeRow, hoursOf, loadExchange, tradingState } from "../services/exchange-service.js";

// The engine tick (PLAN.md → The tick): the worker side of src/engine. It reads each pool's state, runs the pure
// tick() and writes the result back, for one exchange at a time.

export const TICK_SECONDS = 15;
/** The first key of the engine's advisory lock ("AURA"); the second is the exchange. Only one worker ticks an exchange. */
export const ENGINE_LOCK_KEY = 0x41555241;

interface EnginePoolRow {
  id: string;
  season_id: string;
  stock_id: string;
  share_reserve: string;
  credit_reserve: string;
  engine_base: string | null;
  engine_hype: number;
  engine_vol_boost: number;
  engine_drift: DriftSlice[];
  engine_quiet_seconds: number;
  engine_quiet_bleed: number;
  engine_ticked_at: Date | null;
  personality: string;
}

export interface EngineTickResult {
  /** Pools whose price the tick moved. */
  ticked: number;
  /** Why nothing moved, when nothing could. */
  skipped?: "CLOSED" | "TRADING_NOT_OPEN" | "LOCKED";
}

/** The plan's engine numbers, with the trading day taken from the exchange's own hours and its quiet-decay setting. */
export function engineParamsFor(exchange: ExchangeRow): EngineParams {
  return {
    ...DEFAULT_ENGINE_PARAMS,
    tradingDaySeconds: tradingDaySeconds(hoursOf(exchange)),
    quietDecay: exchange.settings.quietDecay === false ? null : DEFAULT_ENGINE_PARAMS.quietDecay
  };
}

function stateOf(row: EnginePoolRow): ListingState {
  const shareReserve = new Decimal(row.share_reserve);
  const creditReserve = new Decimal(row.credit_reserve);
  return {
    shareReserve,
    creditReserve,
    base: row.engine_base === null ? creditReserve.div(shareReserve) : new Decimal(row.engine_base),
    hype: row.engine_hype,
    volBoost: row.engine_vol_boost,
    personality: Number(row.personality),
    drift: row.engine_drift,
    quietSeconds: row.engine_quiet_seconds,
    quietBleed: row.engine_quiet_bleed
  };
}

/**
 * One tick for every live pool in the exchange's active season, in one transaction. It runs only while the market is
 * in PRE, OPEN or AFTER and trading has opened (until then the IPO price stays put). A halted pool sits out and
 * catches up on its first tick after the halt. A pool's first tick only starts its clock.
 *
 * The random draw is seeded by pool and 15-second bucket, so the same state at the same time replays exactly.
 */
export async function engineTick(exchangeId: string, now = new Date()): Promise<EngineTickResult> {
  const exchange = await loadExchange(pool, exchangeId);
  if (!exchange) throw new Error(`No exchange ${exchangeId}`);
  const hours = hoursOf(exchange);
  if (marketSession(hours, exchange.timezone, now).state === "CLOSED") return { ticked: 0, skipped: "CLOSED" };
  if (!(await tradingState(pool, exchangeId)).tradingEnabled) return { ticked: 0, skipped: "TRADING_NOT_OPEN" };
  const params = engineParamsFor(exchange);
  const bucket = new Date(Math.floor(now.getTime() / (TICK_SECONDS * 1000)) * TICK_SECONDS * 1000).toISOString();

  return withTransaction(async (client) => {
    const lock = await one<{ locked: boolean }>(client, "SELECT pg_try_advisory_xact_lock($1::int, hashtext($2)) AS locked", [ENGINE_LOCK_KEY, exchangeId]);
    if (!lock.locked) return { ticked: 0, skipped: "LOCKED" };

    const pools = await client.query<EnginePoolRow>(
      `SELECT mp.id, mp.season_id, mp.stock_id, mp.share_reserve::text, mp.credit_reserve::text, mp.engine_base::text,
              mp.engine_hype, mp.engine_vol_boost, mp.engine_drift, mp.engine_quiet_seconds, mp.engine_quiet_bleed,
              mp.engine_ticked_at, l.personality::text
         FROM market_pools mp
         JOIN seasons s ON s.id=mp.season_id AND s.status='ACTIVE' AND s.exchange_id=mp.exchange_id
         JOIN listings l ON l.id=mp.stock_id
        WHERE mp.exchange_id=$1 AND l.is_active AND (mp.halted_until IS NULL OR mp.halted_until <= $2)
        ORDER BY mp.id FOR UPDATE OF mp`,
      [exchangeId, now]
    );

    let ticked = 0;
    for (const row of pools.rows) {
      if (!row.engine_ticked_at) {
        await client.query(
          "UPDATE market_pools SET engine_base=COALESCE(engine_base, credit_reserve/share_reserve), engine_ticked_at=$2 WHERE id=$1",
          [row.id, now]
        );
        continue;
      }
      const elapsedSeconds = (now.getTime() - row.engine_ticked_at.getTime()) / 1000;
      if (elapsedSeconds <= 0) continue;
      const tradingSeconds = openSecondsBetween(hours, exchange.timezone, row.engine_ticked_at, now);
      const { state, move } = tick(stateOf(row), { elapsedSeconds, tradingSeconds }, seededRng(`${row.id}:${bucket}`), params);

      await client.query(
        `UPDATE market_pools
            SET share_reserve=$2, credit_reserve=$3, engine_base=$4, engine_hype=$5, engine_vol_boost=$6, engine_drift=$7,
                engine_quiet_seconds=$8, engine_quiet_bleed=$9, engine_ticked_at=$10, updated_at=now()
          WHERE id=$1`,
        [row.id, state.shareReserve.toFixed(8), state.creditReserve.toFixed(8), state.base.toFixed(8), state.hype, state.volBoost,
          JSON.stringify(state.drift), state.quietSeconds, state.quietBleed, now]
      );
      await client.query(
        `INSERT INTO market_price_ticks(exchange_id, season_id, stock_id, price, cause, detail, created_at)
         VALUES ($1,$2,$3,$4,'ENGINE',$5,$6)`,
        [exchangeId, row.season_id, row.stock_id, state.creditReserve.div(state.shareReserve).toFixed(8), JSON.stringify(move), now]
      );
      ticked += 1;
    }
    return { ticked };
  });
}

/** PLAN.md → Data retention: raw engine ticks are kept 7 days; candles keep the history. Trade, IPO and news ticks stay. */
export async function purgeOldEngineTicks(): Promise<number> {
  const result = await pool.query("DELETE FROM market_price_ticks WHERE cause IN ('ENGINE','AMBIENT') AND created_at < now() - interval '7 days'");
  return result.rowCount ?? 0;
}
