import type { Pool, PoolClient } from "pg";
import { marketSession, type MarketState } from "../core/market-hours.js";
import { maybeOne, one } from "../db.js";
import { type ExchangeRow, hoursOf, type MembershipRole } from "../services/exchange-service.js";
import { formatTicker, isoTime, isoTimeOrNull, percentOfRatio } from "./serialize.js";

type Db = Pick<Pool | PoolClient, "query">;

/** PLAN.md → Consent and safety: three super-injunctions a season. Spending them is Phase 2. */
export const SUPER_INJUNCTIONS_PER_SEASON = 3;

export interface ListingRefRow {
  id: string;
  ticker: string;
  display_name: string;
}

/** Avatars are served to the console only until uploads move to object storage (Phase 1), so avatarUrl is null. */
export const listingRef = (row: ListingRefRow) => ({ id: row.id, ticker: formatTicker(row.ticker), displayName: row.display_name, avatarUrl: null });

interface MembershipRow {
  id: string;
  exchange_id: string;
  role: MembershipRole;
  listing_consent_at: Date | null;
  joined_at: Date;
  listing_id: string | null;
  ticker: string | null;
  listing_name: string | null;
}

const serializeMembership = (row: MembershipRow) => ({
  id: row.id,
  exchangeId: row.exchange_id,
  role: row.role,
  listing: row.listing_id ? listingRef({ id: row.listing_id, ticker: row.ticker!, display_name: row.listing_name! }) : null,
  listingConsentAt: isoTimeOrNull(row.listing_consent_at),
  joinedAt: isoTime(row.joined_at),
  badges: [],
  superInjunctionsLeft: SUPER_INJUNCTIONS_PER_SEASON,
  superInjunctionsPerSeason: SUPER_INJUNCTIONS_PER_SEASON
});

/** The user's memberships (all of them, or one exchange's), each with its active listing. */
export async function membershipsOf(db: Db, userId: string, exchangeId?: string) {
  const result = await db.query<MembershipRow>(
    `SELECT m.id,m.exchange_id,m.role,m.listing_consent_at,m.joined_at,
            l.id AS listing_id,l.ticker::text AS ticker,l.display_name AS listing_name
       FROM memberships m
       LEFT JOIN listings l ON l.exchange_id=m.exchange_id AND l.owner_user_id=m.user_id AND l.is_active
      WHERE m.user_id=$1 AND ($2::uuid IS NULL OR m.exchange_id=$2)
      ORDER BY m.joined_at,m.id`,
    [userId, exchangeId ?? null]
  );
  return result.rows.map(serializeMembership);
}

/** Every payload with prices says how old it is and what state the market is in (API-CONTRACT.md → Freshness). */
export function freshness(exchange: ExchangeRow, now: Date, asOf: Date = now): { asOf: string; marketState: MarketState; nextChangeAt: string | null } {
  const session = marketSession(hoursOf(exchange), exchange.timezone, now);
  return { asOf: isoTime(asOf), marketState: session.state, nextChangeAt: isoTime(session.nextChangeAt) };
}

export async function exchangeView(db: Db, exchange: ExchangeRow, userId: string) {
  const counts = await one<{ listed: number; members: number }>(db,
    `SELECT (SELECT COUNT(*)::int FROM listings WHERE exchange_id=$1 AND is_active AND consented_at IS NOT NULL) AS listed,
            (SELECT COUNT(*)::int FROM memberships WHERE exchange_id=$1) AS members`,
    [exchange.id]
  );
  const season = await maybeOne<{ id: string; season_number: number; starts_at: Date; ends_at: Date }>(db,
    "SELECT id,season_number,starts_at,ends_at FROM seasons WHERE exchange_id=$1 AND status='ACTIVE'",
    [exchange.id]
  );
  const [me] = await membershipsOf(db, userId, exchange.id);
  return {
    id: exchange.id,
    name: exchange.name,
    timezone: exchange.timezone,
    hours: hoursOf(exchange),
    feeRate: percentOfRatio(exchange.fee_rate),
    extendedFeeRate: percentOfRatio(exchange.extended_fee_rate),
    listedCount: counts.listed,
    memberCount: counts.members,
    minListingsToOpen: exchange.min_listings_to_open,
    season: season
      ? { id: season.id, number: season.season_number, startsAt: isoTime(season.starts_at), endsAt: isoTime(season.ends_at) }
      : null,
    me
  };
}
