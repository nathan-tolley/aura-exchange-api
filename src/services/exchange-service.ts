import type { Pool, PoolClient } from "pg";
import { maybeOne, one } from "../db.js";
import { accounts, postLedgerTransaction } from "../core/ledger.js";
import type { MarketHours } from "../core/market-hours.js";

type Db = Pick<Pool | PoolClient, "query">;

export type MembershipRole = "MEMBER" | "MODERATOR" | "ADMIN";

/** The legacy roles of the /api console mapped to an exchange role. */
export const membershipRoleFor = (legacyRole: string): MembershipRole =>
  legacyRole === "OWNER" ? "ADMIN" : legacyRole === "MODERATOR" ? "MODERATOR" : "MEMBER";

let legacyId: string | null = null;

/** The "Default" exchange that holds everything from before multi-tenancy, and the one the /api console serves. */
export async function legacyExchangeId(db: Db): Promise<string> {
  if (legacyId) return legacyId;
  const row = await one<{ id: string }>(db, "SELECT id FROM exchanges WHERE is_legacy");
  legacyId = row.id;
  return legacyId;
}

export interface SeasonRow {
  id: string;
  season_number: number;
  starts_at: Date;
  ends_at: Date;
}

export async function activeSeason(db: Db, exchangeId: string): Promise<SeasonRow | null> {
  return maybeOne<SeasonRow>(db,
    "SELECT id,season_number,starts_at,ends_at FROM seasons WHERE exchange_id=$1 AND status='ACTIVE'",
    [exchangeId]
  );
}

export async function requireActiveSeason(db: Db, exchangeId: string): Promise<SeasonRow> {
  const season = await activeSeason(db, exchangeId);
  if (!season) throw new Error(`Exchange ${exchangeId} has no active season`);
  return season;
}

export interface TradingState {
  listedCount: number;
  minListingsToOpen: number;
  /** Trading starts once enough members are listed (DECISIONS.md: the market opens at 3 listed friends). */
  tradingEnabled: boolean;
}

export async function tradingState(db: Db, exchangeId: string): Promise<TradingState> {
  const row = await one<{ listed: number; min_listings_to_open: number }>(db,
    `SELECT e.min_listings_to_open,
            (SELECT COUNT(*)::int FROM listings l
              WHERE l.exchange_id=e.id AND l.is_active AND l.consented_at IS NOT NULL) AS listed
       FROM exchanges e WHERE e.id=$1`,
    [exchangeId]
  );
  return { listedCount: row.listed, minListingsToOpen: row.min_listings_to_open, tradingEnabled: row.listed >= row.min_listings_to_open };
}

/** Adds the user to the exchange, or returns their existing membership (`inserted: false`). */
export async function addMembership(db: Db, exchangeId: string, userId: string, role: MembershipRole, listingConsentAt?: "now"): Promise<{ id: string; inserted: boolean }> {
  const row = await one<{ id: string; inserted: boolean }>(db,
    `INSERT INTO memberships(exchange_id,user_id,role,listing_consent_at)
     VALUES ($1,$2,$3,CASE WHEN $4 THEN now() END)
     ON CONFLICT (exchange_id,user_id) DO UPDATE SET updated_at=now()
     RETURNING id, (xmax = 0) AS inserted`,
    [exchangeId, userId, role, listingConsentAt === "now"]
  );
  return row;
}

/** PLAN.md → Economy: A$10,000 at season start or on joining; seasons last 8 weeks. */
export const STARTING_CASH = 10_000;
export const SEASON_WEEKS = 8;
/** PLAN.md pillar 5: one exchange is one friend group of about 4–20 people. */
export const DEFAULT_MAX_MEMBERS = 20;

export async function grantStartingCash(client: PoolClient, userId: string, seasonId: string): Promise<void> {
  await postLedgerTransaction(client, "SEASON_GRANT", "Starting balance", [
    { accountKey: accounts.userCash(userId, seasonId), amount: STARTING_CASH },
    { accountKey: accounts.issuance(seasonId), amount: -STARTING_CASH }
  ], userId);
}

export interface ExchangeRow {
  id: string;
  name: string;
  timezone: string;
  pre_open_time: string;
  open_time: string;
  close_time: string;
  after_close_time: string;
  fee_rate: string;
  extended_fee_rate: string;
  min_listings_to_open: number;
  settings: Record<string, unknown>;
}

export const EXCHANGE_COLUMNS = "id,name,timezone,pre_open_time::text,open_time::text,close_time::text,after_close_time::text,fee_rate::text,extended_fee_rate::text,min_listings_to_open,settings";

export async function loadExchange(db: Db, exchangeId: string): Promise<ExchangeRow | null> {
  return maybeOne<ExchangeRow>(db, `SELECT ${EXCHANGE_COLUMNS} FROM exchanges WHERE id=$1`, [exchangeId]);
}

export const hoursOf = (row: ExchangeRow): MarketHours => ({
  preOpen: row.pre_open_time.slice(0, 5),
  open: row.open_time.slice(0, 5),
  close: row.close_time.slice(0, 5),
  afterClose: row.after_close_time.slice(0, 5)
});

export const maxMembersOf = (row: ExchangeRow): number =>
  typeof row.settings.maxMembers === "number" ? row.settings.maxMembers : DEFAULT_MAX_MEMBERS;

/** A new exchange with season 1, its creator as ADMIN, and the creator's starting cash. */
export async function createExchange(
  client: PoolClient,
  input: { name: string; timezone: string; hours: MarketHours; createdBy: string }
): Promise<string> {
  const exchange = await one<{ id: string }>(client,
    `INSERT INTO exchanges(name,timezone,pre_open_time,open_time,close_time,after_close_time,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [input.name, input.timezone, input.hours.preOpen, input.hours.open, input.hours.close, input.hours.afterClose, input.createdBy]
  );
  const season = await one<{ id: string }>(client,
    `INSERT INTO seasons(exchange_id,season_number,name,starts_at,ends_at)
     VALUES ($1,1,'Season 1',now(),now() + make_interval(weeks => $2)) RETURNING id`,
    [exchange.id, SEASON_WEEKS]
  );
  await addMembership(client, exchange.id, input.createdBy, "ADMIN");
  await grantStartingCash(client, input.createdBy, season.id);
  await client.query(
    "INSERT INTO feed_events(exchange_id,season_id,kind,actor_id,payload) VALUES ($1,$2,'SEASON_STARTED',$3,$4)",
    [exchange.id, season.id, input.createdBy, JSON.stringify({ seasonNumber: 1 })]
  );
  return exchange.id;
}
