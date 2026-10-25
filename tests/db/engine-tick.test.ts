import { Decimal } from "decimal.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db.js";
import { ENGINE_LOCK_KEY, engineTick, purgeOldEngineTicks } from "../../src/jobs/engine-tick.js";
import { candles, listingStats } from "../../src/services/market-data-service.js";
import { addListedMember, createExchange } from "../support/fixtures.js";

// Default hours in New York (EDT, UTC−4): PRE 7–9 am, OPEN 9 am–10 pm, AFTER 10 pm–2 am, CLOSED 2–7 am.
const NOON = new Date("2026-10-24T16:00:00Z");
const later = (seconds: number, from = NOON) => new Date(from.getTime() + seconds * 1000);

let exchangeId: string;
let seasonId: string;
let listings: string[];

interface PoolRow {
  share_reserve: string;
  credit_reserve: string;
  engine_base: string | null;
  engine_hype: number;
  engine_ticked_at: Date | null;
}

const poolOf = async (listingId: string) =>
  (await pool.query<PoolRow>(
    "SELECT share_reserve::text, credit_reserve::text, engine_base::text, engine_hype, engine_ticked_at FROM market_pools WHERE stock_id=$1",
    [listingId]
  )).rows[0]!;
const price = (row: PoolRow) => new Decimal(row.credit_reserve).div(row.share_reserve);
const tickCount = async () => (await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM market_price_ticks WHERE season_id=$1 AND cause='ENGINE'", [seasonId])).rows[0]!.n;

beforeEach(async () => {
  ({ exchangeId, seasonId } = await createExchange(pool));
  listings = [];
  for (const ticker of ["ENGA", "ENGB", "ENGC"]) listings.push((await addListedMember(pool, exchangeId, seasonId, ticker)).listingId);
});

afterAll(async () => {
  await pool.end();
});

describe("the engine tick", () => {
  it("starts each pool's clock on its first tick, then moves the price and keeps the constant product", async () => {
    expect(await engineTick(exchangeId, NOON)).toEqual({ ticked: 0 });
    const started = await poolOf(listings[0]!);
    expect(started.engine_ticked_at).toEqual(NOON);
    expect(started.engine_base).toBe("100.00000000");
    expect(await tickCount()).toBe(0);

    expect(await engineTick(exchangeId, later(15))).toEqual({ ticked: 3 });
    const moved = await poolOf(listings[0]!);
    expect(price(moved).eq(price(started))).toBe(false);
    const k = (row: PoolRow) => new Decimal(row.share_reserve).mul(row.credit_reserve);
    expect(k(moved).div(k(started)).minus(1).abs().lt("1e-9")).toBe(true);
    expect(moved.engine_ticked_at).toEqual(later(15));

    const ticks = await pool.query("SELECT exchange_id, price::text, detail, created_at FROM market_price_ticks WHERE stock_id=$1 AND cause='ENGINE'", [listings[0]]);
    expect(ticks.rows).toHaveLength(1);
    expect(ticks.rows[0]).toMatchObject({ exchange_id: exchangeId, price: price(moved).toFixed(8), created_at: later(15) });
    expect(Object.keys(ticks.rows[0].detail).sort()).toEqual(["drift", "noise", "reversion"]);
  });

  it("replays exactly from the same state at the same time", async () => {
    await engineTick(exchangeId, NOON);
    const before = await poolOf(listings[1]!);
    await engineTick(exchangeId, later(15));
    const first = await poolOf(listings[1]!);

    await pool.query("DELETE FROM market_price_ticks WHERE season_id=$1 AND cause='ENGINE'", [seasonId]);
    await pool.query(
      "UPDATE market_pools SET share_reserve=$2, credit_reserve=$3, engine_ticked_at=$4, engine_quiet_seconds=0 WHERE stock_id=$1",
      [listings[1], before.share_reserve, before.credit_reserve, before.engine_ticked_at]
    );
    await engineTick(exchangeId, later(15));
    expect(await poolOf(listings[1]!)).toEqual(first);
  });

  it("only ticks in PRE, OPEN and AFTER, and only once trading has opened", async () => {
    await engineTick(exchangeId, NOON);
    const threeAm = new Date("2026-10-25T07:00:00Z");
    expect(await engineTick(exchangeId, threeAm)).toEqual({ ticked: 0, skipped: "CLOSED" });
    expect(await engineTick(exchangeId, new Date("2026-10-25T03:00:00Z"))).toEqual({ ticked: 3 });
    expect(await engineTick(exchangeId, new Date("2026-10-25T11:00:15Z"))).toEqual({ ticked: 3 });

    await pool.query("UPDATE exchanges SET min_listings_to_open=4 WHERE id=$1", [exchangeId]);
    expect(await engineTick(exchangeId, new Date("2026-10-25T11:00:30Z"))).toEqual({ ticked: 0, skipped: "TRADING_NOT_OPEN" });
  });

  it("decays hype over wall-clock time but adds noise only for open-market time", async () => {
    // Ticked at 1:59 am (AFTER), next at 7:00 am (PRE): five hours apart, a minute of it open.
    await engineTick(exchangeId, new Date("2026-10-25T05:59:00Z"));
    await pool.query("UPDATE market_pools SET engine_hype=0.1 WHERE stock_id=$1", [listings[0]]);
    await engineTick(exchangeId, new Date("2026-10-25T11:00:00Z"));
    const row = await poolOf(listings[0]!);
    expect(row.engine_hype).toBeCloseTo(0.1 * 0.5 ** ((5 * 3600 + 60) / (3 * 24 * 3600)), 12);
    const { rows } = await pool.query("SELECT detail FROM market_price_ticks WHERE stock_id=$1 AND cause='ENGINE'", [listings[0]]);
    // A minute of noise at 2% a 19-hour day is a few hundredths of a percent, not five hours' worth.
    expect(Math.abs(rows[0].detail.noise)).toBeLessThan(0.02 * Math.sqrt(60 / (19 * 3600)) * 10);
  });

  it("leaves halted and delisted pools alone", async () => {
    // Delisting one leaves two listed; keep trading open so the third still ticks.
    await pool.query("UPDATE exchanges SET min_listings_to_open=1 WHERE id=$1", [exchangeId]);
    await engineTick(exchangeId, NOON);
    await pool.query("UPDATE market_pools SET halted_until=$2 WHERE stock_id=$1", [listings[0], later(300)]);
    await pool.query("UPDATE listings SET is_active=false WHERE id=$1", [listings[1]]);
    const halted = await poolOf(listings[0]!);
    const delisted = await poolOf(listings[1]!);
    expect(await engineTick(exchangeId, later(15))).toEqual({ ticked: 1 });
    expect(await poolOf(listings[0]!)).toEqual(halted);
    expect(await poolOf(listings[1]!)).toEqual(delisted);
    // After the halt, the pool catches up from its last tick.
    expect(await engineTick(exchangeId, later(315))).toEqual({ ticked: 2 });
  });

  it("skips while another worker holds the exchange's engine lock", async () => {
    await engineTick(exchangeId, NOON);
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::int, hashtext($2))", [ENGINE_LOCK_KEY, exchangeId]);
      const before = await poolOf(listings[0]!);
      expect(await engineTick(exchangeId, later(15))).toEqual({ ticked: 0, skipped: "LOCKED" });
      expect(await poolOf(listings[0]!)).toEqual(before);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1::int, hashtext($2))", [ENGINE_LOCK_KEY, exchangeId]);
      holder.release();
    }
    expect((await engineTick(exchangeId, later(15))).ticked).toBe(3);
  });
});

describe("candles", () => {
  const insertTick = (listingId: string, value: string, at: Date, cause = "ENGINE") =>
    pool.query("INSERT INTO market_price_ticks(season_id, stock_id, price, cause, created_at) VALUES ($1,$2,$3,$4,$5)", [seasonId, listingId, value, cause, at]);

  it("keeps 1-minute and 1-hour candles from every tick, even ones inserted out of order", async () => {
    const id = listings[2]!;
    const minute = new Date("2026-10-24T16:05:00Z");
    await insertTick(id, "101", later(10, minute));
    await insertTick(id, "104", later(30, minute));
    await insertTick(id, "99", later(20, minute));
    await insertTick(id, "100", later(0, minute), "TRADE");
    await insertTick(id, "102", later(50, minute));
    await insertTick(id, "103", later(70, minute));

    const ones = await pool.query("SELECT t, o::text, h::text, l::text, c::text FROM candles_1m WHERE stock_id=$1 AND t >= $2 ORDER BY t", [id, minute]);
    expect(ones.rows).toEqual([
      { t: minute, o: "100.00000000", h: "104.00000000", l: "99.00000000", c: "102.00000000" },
      { t: later(60, minute), o: "103.00000000", h: "103.00000000", l: "103.00000000", c: "103.00000000" }
    ]);
    const hour = await pool.query("SELECT exchange_id, o::text, h::text, l::text, c::text FROM candles_1h WHERE stock_id=$1 AND t=$2", [id, new Date("2026-10-24T16:00:00Z")]);
    expect(hour.rows).toEqual([{ exchange_id: exchangeId, o: "100.00000000", h: "104.00000000", l: "99.00000000", c: "103.00000000" }]);
  });

  it("serves the chart from the candles", async () => {
    const id = listings[2]!;
    // Both inside one 5-minute bucket an hour ago.
    const recent = new Date(Math.floor((Date.now() - 3600_000) / 300_000) * 300_000 + 30_000);
    await insertTick(id, "110", recent);
    await insertTick(id, "90", later(60, recent));
    const day = await candles(pool, seasonId, id, "1D");
    expect(day.interval).toBe("5m");
    expect(day.rows.map((row) => [row.h, row.l])).toContainEqual(["110.00000000", "90.00000000"]);
    const stats = await listingStats(pool, seasonId, id);
    expect({ high: stats.day_high, low: stats.day_low }).toEqual({ high: "110.00000000", low: "90.00000000" });
  });

  it("purges engine ticks after 7 days but keeps trade ticks and every candle", async () => {
    const id = listings[2]!;
    const old = new Date(Date.now() - 8 * 24 * 3600_000);
    await insertTick(id, "120", old);
    await insertTick(id, "80", later(1, old), "TRADE");
    await insertTick(id, "100", new Date(Date.now() - 60_000));
    const candlesBefore = (await pool.query("SELECT COUNT(*)::int AS n FROM candles_1m WHERE stock_id=$1", [id])).rows[0].n;

    expect(await purgeOldEngineTicks()).toBeGreaterThanOrEqual(1);
    const left = await pool.query("SELECT cause, price::text FROM market_price_ticks WHERE stock_id=$1 ORDER BY created_at", [id]);
    expect(left.rows).toEqual([{ cause: "TRADE", price: "80.00000000" }, { cause: "ENGINE", price: "100.00000000" }]);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM candles_1m WHERE stock_id=$1", [id])).rows[0].n).toBe(candlesBefore);
    const stats = await listingStats(pool, seasonId, id);
    expect({ high: stats.season_high, low: stats.season_low }).toEqual({ high: "120.00000000", low: "80.00000000" });
  });
});
