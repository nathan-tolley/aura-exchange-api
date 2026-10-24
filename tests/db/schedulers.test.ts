import { Decimal } from "decimal.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db.js";
import { accountBalance, accounts } from "../../src/core/ledger.js";
import {
  applyAmbientMarketMotion, closeExpiredSeason, grantAllowance, runExchangeSchedulers, snapshotIndices, zonedParts
} from "../../src/jobs/schedulers.js";
import { activeSeason } from "../../src/services/exchange-service.js";
import { addListedMember, createExchange } from "../support/fixtures.js";

interface World {
  exchangeId: string;
  seasonId: string;
  members: Array<{ userId: string; listingId: string }>;
}

let a: World;
let b: World;

async function world(prefix: string): Promise<World> {
  const { exchangeId, seasonId } = await createExchange(pool);
  const members = [
    await addListedMember(pool, exchangeId, seasonId, `${prefix}AA`),
    await addListedMember(pool, exchangeId, seasonId, `${prefix}BB`)
  ];
  return { exchangeId, seasonId, members };
}

const cash = async (w: World, index: number) => accountBalance(pool as never, accounts.userCash(w.members[index]!.userId, w.seasonId));
const reserves = async (w: World) =>
  (await pool.query("SELECT stock_id,share_reserve::text,credit_reserve::text FROM market_pools WHERE season_id=$1 ORDER BY stock_id", [w.seasonId])).rows;

beforeEach(async () => {
  a = await world("A");
  b = await world("B");
});

afterAll(async () => {
  await pool.end();
});

describe("per-exchange scheduled jobs", () => {
  it("grants the allowance only to the exchange's own members", async () => {
    await grantAllowance(a.exchangeId, "2026-10-26");
    expect((await cash(a, 0)).toFixed(2)).toBe("11000.00");
    expect((await cash(a, 1)).toFixed(2)).toBe("11000.00");
    expect((await cash(b, 0)).toFixed(2)).toBe("10000.00");
  });

  it("moves only the exchange's own pools, keeping each pool's constant product", async () => {
    const before = await reserves(b);
    const aBefore = await reserves(a);
    await applyAmbientMarketMotion(a.exchangeId);
    expect(await reserves(b)).toEqual(before);
    for (const [index, row] of (await reserves(a)).entries()) {
      const k = new Decimal(row.share_reserve).mul(row.credit_reserve);
      const kBefore = new Decimal(aBefore[index]!.share_reserve).mul(aBefore[index]!.credit_reserve);
      expect(k.div(kBefore).minus(1).abs().lt("0.000001")).toBe(true);
    }
    const ticks = await pool.query("SELECT DISTINCT exchange_id FROM market_price_ticks WHERE season_id IN ($1,$2)", [a.seasonId, b.seasonId]);
    expect(ticks.rows).toEqual([{ exchange_id: a.exchangeId }]);
  });

  it("snapshots the index per exchange", async () => {
    await snapshotIndices(a.exchangeId);
    const rows = await pool.query("SELECT exchange_id FROM index_snapshots WHERE season_id IN ($1,$2)", [a.seasonId, b.seasonId]);
    expect(rows.rows).toEqual([{ exchange_id: a.exchangeId }]);
  });

  it("closes an expired season without touching other exchanges", async () => {
    await pool.query("UPDATE listings SET seasonal_aura=120 WHERE exchange_id IN ($1,$2)", [a.exchangeId, b.exchangeId]);
    await pool.query("UPDATE seasons SET ends_at=now()-interval '1 minute' WHERE id=$1", [a.seasonId]);
    await closeExpiredSeason(b.exchangeId);
    expect((await activeSeason(pool, b.exchangeId))?.id).toBe(b.seasonId);

    await closeExpiredSeason(a.exchangeId);
    const next = await activeSeason(pool, a.exchangeId);
    expect(next?.season_number).toBe(2);
    expect((await accountBalance(pool as never, accounts.userCash(a.members[0]!.userId, next!.id))).toFixed(2)).toBe("10000.00");
    const aura = await pool.query("SELECT exchange_id, seasonal_aura::int AS aura FROM listings WHERE exchange_id IN ($1,$2) ORDER BY exchange_id=$1 DESC", [a.exchangeId, b.exchangeId]);
    expect(aura.rows.filter((row) => row.exchange_id === a.exchangeId).every((row) => row.aura === 100)).toBe(true);
    expect(aura.rows.filter((row) => row.exchange_id === b.exchangeId).every((row) => row.aura === 120)).toBe(true);
    expect((await activeSeason(pool, b.exchangeId))?.id).toBe(b.seasonId);
  });

  it("runs Monday's jobs once per exchange, on the exchange's own clock", async () => {
    const mondayMorningInNewYork = new Date("2026-10-26T14:00:00Z");
    expect(zonedParts("America/New_York", mondayMorningInNewYork)).toMatchObject({ weekday: "Mon", hour: "10" });
    await runExchangeSchedulers({ id: a.exchangeId, timezone: "America/New_York" }, mondayMorningInNewYork);
    await runExchangeSchedulers({ id: a.exchangeId, timezone: "America/New_York" }, mondayMorningInNewYork);
    expect((await cash(a, 0)).toFixed(2)).toBe("11000.00");
    expect((await cash(b, 0)).toFixed(2)).toBe("10000.00");

    // Still Sunday night in Honolulu, so no allowance there yet.
    await pool.query("UPDATE exchanges SET timezone='Pacific/Honolulu' WHERE id=$1", [b.exchangeId]);
    expect(zonedParts("Pacific/Honolulu", mondayMorningInNewYork).weekday).toBe("Mon");
    const sundayInHonolulu = new Date("2026-10-26T09:00:00Z");
    expect(zonedParts("Pacific/Honolulu", sundayInHonolulu).weekday).toBe("Sun");
    await runExchangeSchedulers({ id: b.exchangeId, timezone: "Pacific/Honolulu" }, sundayInHonolulu);
    expect((await cash(b, 0)).toFixed(2)).toBe("10000.00");
  });
});
