import type { FastifyInstance } from "fastify";
import { maybeOne, pool } from "../db.js";
import { appError } from "../errors.js";
import type { MembershipRole } from "../services/exchange-service.js";
import type { AppUserRow } from "../services/login-code-service.js";
import { formatTicker, isoTime, isoTimeOrNull, serializeUser } from "./serialize.js";

/** PLAN.md → Consent and safety: three super-injunctions a season. Spending them is Phase 2. */
export const SUPER_INJUNCTIONS_PER_SEASON = 3;

export async function registerMeRoutes(v1: FastifyInstance): Promise<void> {
  v1.get("/me", async (request) => {
    const user = await maybeOne<AppUserRow>(pool,
      "SELECT id,email::text,display_name,username::text,created_at FROM users WHERE id=$1",
      [request.v1User!.id]
    );
    if (!user) throw appError("AUTH_EXPIRED", {}, "This account no longer exists");
    const memberships = await pool.query<{
      id: string; exchange_id: string; role: MembershipRole; listing_consent_at: Date | null; joined_at: Date;
      listing_id: string | null; ticker: string | null; listing_name: string | null;
    }>(
      `SELECT m.id,m.exchange_id,m.role,m.listing_consent_at,m.joined_at,
              l.id AS listing_id,l.ticker::text AS ticker,l.display_name AS listing_name
         FROM memberships m
         LEFT JOIN listings l ON l.exchange_id=m.exchange_id AND l.owner_user_id=m.user_id AND l.is_active
        WHERE m.user_id=$1 ORDER BY m.joined_at,m.id`,
      [user.id]
    );
    return {
      user: serializeUser(user),
      memberships: memberships.rows.map((row) => ({
        id: row.id,
        exchangeId: row.exchange_id,
        role: row.role,
        // Avatars are served to the console only until uploads move to object storage (Phase 1).
        listing: row.listing_id ? { id: row.listing_id, ticker: formatTicker(row.ticker!), displayName: row.listing_name!, avatarUrl: null } : null,
        listingConsentAt: isoTimeOrNull(row.listing_consent_at),
        joinedAt: isoTime(row.joined_at),
        badges: [],
        superInjunctionsLeft: SUPER_INJUNCTIONS_PER_SEASON
      }))
    };
  });
}
