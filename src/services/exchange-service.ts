import type { Pool, PoolClient } from "pg";
import { maybeOne, one } from "../db.js";

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

export async function addMembership(db: Db, exchangeId: string, userId: string, role: MembershipRole, listingConsentAt?: "now"): Promise<string> {
  const row = await one<{ id: string }>(db,
    `INSERT INTO memberships(exchange_id,user_id,role,listing_consent_at)
     VALUES ($1,$2,$3,CASE WHEN $4 THEN now() END)
     ON CONFLICT (exchange_id,user_id) DO UPDATE SET updated_at=now()
     RETURNING id`,
    [exchangeId, userId, role, listingConsentAt === "now"]
  );
  return row.id;
}
