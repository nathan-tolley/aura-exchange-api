import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { one } from "../../src/db.js";
import { accounts, postLedgerTransaction } from "../../src/core/ledger.js";

type Db = Pick<Pool | PoolClient, "query">;

/** Test data builders. Everything gets random names so test files can share one database. */

const suffix = () => randomUUID().slice(0, 8);

export async function createUser(db: Db, label = "user"): Promise<string> {
  const row = await one<{ id: string }>(db,
    "INSERT INTO users(username,password_hash) VALUES ($1,'not-a-real-hash') RETURNING id",
    [`${label}_${suffix()}`]
  );
  return row.id;
}

export async function createExchange(db: Db, name = `Exchange ${suffix()}`): Promise<{ exchangeId: string; seasonId: string }> {
  const exchange = await one<{ id: string }>(db, "INSERT INTO exchanges(name,timezone) VALUES ($1,'America/New_York') RETURNING id", [name]);
  const season = await one<{ id: string }>(db,
    `INSERT INTO seasons(exchange_id,season_number,name,starts_at,ends_at)
     VALUES ($1,1,'Season 1',now()-interval '1 day',now()+interval '8 weeks') RETURNING id`,
    [exchange.id]
  );
  return { exchangeId: exchange.id, seasonId: season.id };
}

/** A member with a consented, active listing, a pool and the starting grant, like a claimed legacy stock. */
export async function addListedMember(db: Db, exchangeId: string, seasonId: string, ticker: string): Promise<{ userId: string; listingId: string }> {
  const userId = await createUser(db, ticker.toLowerCase());
  await db.query("INSERT INTO memberships(exchange_id,user_id,role,listing_consent_at) VALUES ($1,$2,'MEMBER',now())", [exchangeId, userId]);
  const listing = await one<{ id: string }>(db,
    `INSERT INTO listings(exchange_id,display_name,ticker,owner_user_id,is_active,claimed_at,consented_at)
     VALUES ($1,$2,$3,$4,true,now(),now()) RETURNING id`,
    [exchangeId, ticker, ticker, userId]
  );
  await db.query("INSERT INTO market_pools(season_id,stock_id) VALUES ($1,$2)", [seasonId, listing.id]);
  await postLedgerTransaction(db as PoolClient, "SEASON_GRANT", "Initial season balance", [
    { accountKey: accounts.userCash(userId, seasonId), amount: 10_000 },
    { accountKey: accounts.issuance(seasonId), amount: -10_000 }
  ], userId);
  return { userId, listingId: listing.id };
}
