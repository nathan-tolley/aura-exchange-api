import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashToken } from "../auth.js";
import { config } from "../config.js";
import { maybeOne, one, pool, withTransaction } from "../db.js";
import { appError } from "../errors.js";
import { addMembership, grantStartingCash, loadExchange, maxMembersOf } from "../services/exchange-service.js";
import { ipo, isTickerAvailable, isValidTicker, normalizeTicker, suggestTickers } from "../services/listing-service.js";
import { membershipGuard } from "./membership.js";
import { formatTicker, isoTime } from "./serialize.js";
import { listingRef, membershipsOf } from "./views.js";

/** Invite links are shared in the group chat, so one code admits anyone until it expires. */
export const INVITE_DAYS = 7;
// No 0/O or 1/I, so a code read aloud or retyped survives.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const newInviteCode = () => {
  const chars = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
};

/** "abcd efgh", "ABCDEFGH" and "ABCD-EFGH" are the same code. */
const normalizeCode = (raw: string) => {
  const chars = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return chars.length === 8 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars;
};

interface InviteRow {
  id: string;
  exchange_id: string;
  expires_at: Date;
  expired: boolean;
}

async function findInvite(code: string): Promise<InviteRow> {
  const invite = await maybeOne<InviteRow>(pool,
    "SELECT id,exchange_id,expires_at,expires_at<=now() AS expired FROM invites WHERE code_hash=$1 AND person_stock_id IS NULL",
    [hashToken(normalizeCode(code))]
  );
  if (!invite) throw appError("NOT_FOUND", { resource: "invite" }, "No such invite");
  return invite;
}

export async function registerInviteRoutes(v1: FastifyInstance): Promise<void> {
  v1.post("/exchanges/:exchangeId/invites", { preHandler: membershipGuard() }, async (request, reply) => {
    const exchangeId = request.membership!.exchangeId;
    const code = newInviteCode();
    const invite = await one<{ expires_at: Date }>(pool,
      `INSERT INTO invites(exchange_id,code_hash,expires_at,created_by) VALUES ($1,$2,now() + make_interval(days => $3),$4)
       RETURNING expires_at`,
      [exchangeId, hashToken(code), INVITE_DAYS, request.v1User!.id]
    );
    reply.code(201);
    return { code, url: `${config.INVITE_URL_BASE}${code}`, expiresAt: isoTime(invite.expires_at) };
  });

  v1.get("/invites/:code", async (request) => {
    const code = normalizeCode((request.params as { code: string }).code);
    const invite = await findInvite(code);
    const exchange = (await loadExchange(pool, invite.exchange_id))!;
    const listed = await pool.query<{ id: string; ticker: string; display_name: string }>(
      "SELECT id,ticker::text,display_name FROM listings WHERE exchange_id=$1 AND is_active AND consented_at IS NOT NULL ORDER BY ticker",
      [exchange.id]
    );
    const members = await one<{ count: number }>(pool, "SELECT COUNT(*)::int AS count FROM memberships WHERE exchange_id=$1", [exchange.id]);
    return {
      code,
      exchangeName: exchange.name,
      listed: listed.rows.map(listingRef),
      memberCount: members.count,
      expiresAt: isoTime(invite.expires_at),
      status: invite.expired ? "EXPIRED" : members.count >= maxMembersOf(exchange) ? "FULL" : "VALID"
    };
  });

  // Joining is safe to repeat: an existing member gets their membership back, and the starting cash is granted once.
  v1.post("/invites/:code/accept", async (request) => {
    const invite = await findInvite((request.params as { code: string }).code);
    const userId = request.v1User!.id;
    await withTransaction(async (client) => {
      const exchange = (await loadExchange(client, invite.exchange_id))!;
      await client.query("SELECT 1 FROM exchanges WHERE id=$1 FOR UPDATE", [exchange.id]);
      const already = await client.query("SELECT 1 FROM memberships WHERE exchange_id=$1 AND user_id=$2", [exchange.id, userId]);
      if (already.rowCount) return;
      if (invite.expired) throw appError("INVITE_EXPIRED", {}, "This invite has expired");
      const members = await one<{ count: number }>(client, "SELECT COUNT(*)::int AS count FROM memberships WHERE exchange_id=$1", [exchange.id]);
      if (members.count >= maxMembersOf(exchange)) {
        throw appError("EXCHANGE_FULL", { maxMembers: String(maxMembersOf(exchange)) }, "This exchange is full");
      }
      const membership = await addMembership(client, exchange.id, userId, "MEMBER");
      if (!membership.inserted) return;
      const season = await one<{ id: string }>(client, "SELECT id FROM seasons WHERE exchange_id=$1 AND status='ACTIVE'", [exchange.id]);
      await grantStartingCash(client, userId, season.id);
      await client.query("UPDATE invites SET uses=uses+1 WHERE id=$1", [invite.id]);
      await client.query(
        `INSERT INTO feed_events(exchange_id,season_id,kind,actor_id,payload)
         SELECT $1,$2,'MEMBER_JOINED',id,jsonb_build_object('displayName',display_name) FROM users WHERE id=$3`,
        [exchange.id, season.id, userId]
      );
    });
    const [membership] = await membershipsOf(pool, userId, invite.exchange_id);
    return membership;
  });

  v1.get("/exchanges/:exchangeId/tickers/check", { preHandler: membershipGuard() }, async (request) => {
    const exchangeId = request.membership!.exchangeId;
    const wanted = normalizeTicker(String((request.query as { ticker?: unknown }).ticker ?? ""));
    const available = isValidTicker(wanted) && (await isTickerAvailable(pool, exchangeId, wanted));
    const user = await one<{ name: string }>(pool, "SELECT COALESCE(display_name,'') AS name FROM users WHERE id=$1", [request.v1User!.id]);
    return {
      ticker: formatTicker(wanted),
      available,
      suggestions: available ? [] : (await suggestTickers(pool, exchangeId, wanted, user.name)).map(formatTicker)
    };
  });

  v1.post("/exchanges/:exchangeId/listing", { preHandler: membershipGuard() }, async (request, reply) => {
    const input = z.object({ ticker: z.string().regex(/^[A-Za-z]{3,5}$/), consent: z.literal(true) }).parse(request.body);
    const listing = await withTransaction((client) => ipo(client, {
      exchangeId: request.membership!.exchangeId, userId: request.v1User!.id, ticker: normalizeTicker(input.ticker)
    }));
    reply.code(201);
    return listingRef(listing);
  });
}
