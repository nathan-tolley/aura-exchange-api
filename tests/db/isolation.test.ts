import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db.js";
import { tradingState } from "../../src/services/exchange-service.js";
import { addListedMember, createExchange } from "../support/fixtures.js";

// The 0.3 check: two exchanges, and no data crosses between them. The legacy console's side of this lives in
// tests/legacy/api-smoke.test.ts (it owns the Default exchange); the per-exchange jobs in tests/db/schedulers.test.ts.

const PARENT_COLUMNS: Record<string, string> = { season_id: "seasons", stock_id: "listings", subject_stock_id: "listings", person_stock_id: "listings" };

async function columnsByTable(): Promise<Map<string, Set<string>>> {
  const result = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema AND t.table_type='BASE TABLE'
      WHERE c.table_schema='public'`
  );
  const tables = new Map<string, Set<string>>();
  for (const row of result.rows) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, new Set());
    tables.get(row.table_name)!.add(row.column_name);
  }
  return tables;
}

let x: { exchangeId: string; seasonId: string };
let y: { exchangeId: string; seasonId: string };

beforeAll(async () => {
  x = await createExchange(pool);
  y = await createExchange(pool);
  for (const ticker of ["XAAA", "XBBB", "XCCC"]) await addListedMember(pool, x.exchangeId, x.seasonId, ticker);
  for (const ticker of ["YAAA", "XAAA"]) await addListedMember(pool, y.exchangeId, y.seasonId, ticker);
});

afterAll(async () => {
  await pool.end();
});

describe("no data crosses between exchanges", () => {
  it("puts an exchange_id and its enforcing trigger on every table that references a season or listing", async () => {
    const tables = await columnsByTable();
    const triggers = await pool.query<{ table_name: string }>(
      "SELECT tgrelid::regclass::text AS table_name FROM pg_trigger WHERE tgname='enforce_exchange_id' AND NOT tgisinternal"
    );
    const enforced = new Set(triggers.rows.map((row) => row.table_name));
    const missingColumn: string[] = [];
    const missingTrigger: string[] = [];
    for (const [table, columns] of tables) {
      const parents = Object.keys(PARENT_COLUMNS).filter((column) => columns.has(column));
      if (!parents.length || table === "listings" || table === "seasons") continue;
      if (!columns.has("exchange_id")) missingColumn.push(table);
      else if (!enforced.has(table)) missingTrigger.push(table);
    }
    expect(missingColumn).toEqual([]);
    expect(missingTrigger).toEqual([]);
  });

  it("has no row anywhere whose exchange differs from its season's or listing's", async () => {
    const tables = await columnsByTable();
    const mismatches: string[] = [];
    for (const [table, columns] of tables) {
      if (!columns.has("exchange_id")) continue;
      for (const [column, parent] of Object.entries(PARENT_COLUMNS)) {
        if (!columns.has(column)) continue;
        const result = await pool.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ${table} child JOIN ${parent} parent ON parent.id=child.${column} WHERE child.exchange_id<>parent.exchange_id`
        );
        if (result.rows[0]!.count) mismatches.push(`${table}.${column}: ${result.rows[0]!.count}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("lets two exchanges reuse a ticker without sharing anything", async () => {
    const listings = await pool.query<{ exchange_id: string; count: number }>(
      "SELECT exchange_id, COUNT(*)::int AS count FROM listings WHERE ticker='XAAA' AND exchange_id IN ($1,$2) GROUP BY exchange_id",
      [x.exchangeId, y.exchangeId]
    );
    expect(listings.rows).toHaveLength(2);
    expect(await tradingState(pool, x.exchangeId)).toMatchObject({ listedCount: 3, tradingEnabled: true });
    expect(await tradingState(pool, y.exchangeId)).toMatchObject({ listedCount: 2, tradingEnabled: false });
  });

  it("refuses to record a trade, position or order on one exchange's season for another's listing", async () => {
    const yListing = (await pool.query<{ id: string }>("SELECT id FROM listings WHERE exchange_id=$1 LIMIT 1", [y.exchangeId])).rows[0]!.id;
    const xUser = (await pool.query<{ owner_user_id: string }>("SELECT owner_user_id FROM listings WHERE exchange_id=$1 LIMIT 1", [x.exchangeId])).rows[0]!.owner_user_id;
    await expect(pool.query("INSERT INTO positions(season_id,user_id,stock_id) VALUES ($1,$2,$3)", [x.seasonId, xUser, yListing])).rejects.toThrow(/belongs to exchange/);
    await expect(pool.query(
      "INSERT INTO limit_orders(season_id,user_id,stock_id,side,quantity,limit_price) VALUES ($1,$2,$3,'BUY',1,50)", [x.seasonId, xUser, yListing]
    )).rejects.toThrow(/belongs to exchange/);
    await expect(pool.query(
      "INSERT INTO feed_events(exchange_id,season_id,kind,subject_stock_id) VALUES ($1,$2,'TRADE',$3)", [x.exchangeId, x.seasonId, yListing]
    )).rejects.toThrow(/belongs to exchange/);
  });
});
