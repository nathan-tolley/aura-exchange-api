import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db.js";
import { legacyExchangeId, tradingState } from "../../src/services/exchange-service.js";
import { addListedMember, createExchange } from "../support/fixtures.js";

afterAll(async () => {
  await pool.end();
});

describe("multi-tenant schema (migration 013)", () => {
  it("keeps the pre-multi-tenancy data in one Default exchange", async () => {
    const id = await legacyExchangeId(pool);
    const row = await pool.query("SELECT name,is_legacy FROM exchanges WHERE id=$1", [id]);
    expect(row.rows[0]).toEqual({ name: "Default", is_legacy: true });
  });

  it("fills exchange_id from the parent row when a write leaves it out", async () => {
    const { exchangeId, seasonId } = await createExchange(pool);
    const { listingId } = await addListedMember(pool, exchangeId, seasonId, "FILL");
    const poolRow = await pool.query("SELECT exchange_id FROM market_pools WHERE season_id=$1 AND stock_id=$2", [seasonId, listingId]);
    expect(poolRow.rows[0].exchange_id).toBe(exchangeId);
  });

  it("refuses rows that mix two exchanges", async () => {
    const a = await createExchange(pool);
    const b = await createExchange(pool);
    const { listingId: listingInB } = await addListedMember(pool, b.exchangeId, b.seasonId, "MIXB");
    await expect(pool.query("INSERT INTO market_pools(season_id,stock_id) VALUES ($1,$2)", [a.seasonId, listingInB]))
      .rejects.toThrow(/belongs to exchange/);
    await expect(pool.query("INSERT INTO index_snapshots(exchange_id,season_id,aura_composite,market_index) VALUES ($1,$2,100,100)", [b.exchangeId, a.seasonId]))
      .rejects.toThrow(/belongs to exchange/);
  });

  it("refuses game rows with no exchange at all", async () => {
    await expect(pool.query("INSERT INTO glossary_entries(phrase,explanation,created_by) SELECT 'orphan','x',id FROM users LIMIT 1"))
      .rejects.toThrow();
  });

  it("makes tickers, seasons and listings unique per exchange, not globally", async () => {
    const a = await createExchange(pool);
    const b = await createExchange(pool);
    await addListedMember(pool, a.exchangeId, a.seasonId, "SAME");
    await addListedMember(pool, b.exchangeId, b.seasonId, "SAME");
    await expect(addListedMember(pool, a.exchangeId, a.seasonId, "SAME")).rejects.toThrow(/listings_exchange_ticker_key/);
    await expect(pool.query(
      "INSERT INTO seasons(exchange_id,season_number,name,starts_at,ends_at) VALUES ($1,2,'Season 2',now(),now()+interval '1 week')",
      [a.exchangeId]
    )).rejects.toThrow(/one_active_season_per_exchange/);
  });

  it("opens trading once minListingsToOpen members are listed", async () => {
    const { exchangeId, seasonId } = await createExchange(pool);
    expect(await tradingState(pool, exchangeId)).toEqual({ listedCount: 0, minListingsToOpen: 3, tradingEnabled: false });
    await addListedMember(pool, exchangeId, seasonId, "ONEE");
    await addListedMember(pool, exchangeId, seasonId, "TWOO");
    expect((await tradingState(pool, exchangeId)).tradingEnabled).toBe(false);
    await addListedMember(pool, exchangeId, seasonId, "THRE");
    expect(await tradingState(pool, exchangeId)).toEqual({ listedCount: 3, minListingsToOpen: 3, tradingEnabled: true });
  });
});
