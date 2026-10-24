import type { FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { maybeOne, pool } from "../db.js";
import { appError } from "../errors.js";
import type { MembershipRole } from "../services/exchange-service.js";

type Db = Pick<Pool | PoolClient, "query">;

export interface V1User {
  id: string;
}

export interface MembershipContext {
  id: string;
  exchangeId: string;
  role: MembershipRole;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in /v1 user, set by the bearer guard (0.4). Never derived from the console's cookie. */
    v1User: V1User | null;
    /** Set by membershipGuard on exchange-scoped routes. */
    membership: MembershipContext | null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tables a /v1 route may address by id, mapped to the contract's `resource` name for NOT_FOUND. */
const scopedResources = {
  listings: "listing",
  positions: "position",
  limit_orders: "order",
  aura_submissions: "event",
  aura_swing_polls: "halt",
  trade_quotes: "quote"
} as const;

export type ScopedTable = keyof typeof scopedResources;

export async function findMembership(db: Db, userId: string, exchangeId: string): Promise<MembershipContext | null> {
  if (!UUID.test(exchangeId)) return null;
  const row = await maybeOne<{ id: string; exchange_id: string; role: MembershipRole }>(db,
    "SELECT id,exchange_id,role FROM memberships WHERE user_id=$1 AND exchange_id=$2",
    [userId, exchangeId]
  );
  return row ? { id: row.id, exchangeId: row.exchange_id, role: row.role } : null;
}

/** 403 NOT_A_MEMBER unless the user belongs to the exchange (unknown and malformed ids included, so nothing leaks). */
export async function requireMembership(db: Db, userId: string, exchangeId: string): Promise<MembershipContext> {
  const membership = await findMembership(db, userId, exchangeId);
  if (!membership) throw appError("NOT_A_MEMBER", { exchangeId }, "You are not a member of this exchange");
  return membership;
}

function signedInUser(request: FastifyRequest): V1User {
  if (!request.v1User) throw appError("AUTH_EXPIRED", {}, "Sign in required");
  return request.v1User;
}

/** preHandler for /v1 routes with an `:exchangeId` param. */
export function membershipGuard(options: { roles?: MembershipRole[] } = {}) {
  return async (request: FastifyRequest): Promise<void> => {
    const user = signedInUser(request);
    const exchangeId = String((request.params as { exchangeId?: unknown }).exchangeId ?? "");
    const membership = await requireMembership(pool, user.id, exchangeId);
    if (options.roles && !options.roles.includes(membership.role)) {
      throw appError("FORBIDDEN", {}, "Your role on this exchange does not allow this");
    }
    request.membership = membership;
  };
}

/**
 * For routes addressed by a resource id (a listing, position, order, event…): finds the resource's exchange and
 * requires membership. A resource on an exchange you're not in answers 404 exactly like one that doesn't exist.
 */
export async function requireScopedResource(db: Db, request: FastifyRequest, table: ScopedTable, id: string): Promise<MembershipContext> {
  const user = signedInUser(request);
  const resource = scopedResources[table];
  const notFound = () => appError("NOT_FOUND", { resource }, `No such ${resource}`);
  if (!UUID.test(id)) throw notFound();
  const row = await maybeOne<{ exchange_id: string }>(db, `SELECT exchange_id FROM ${table} WHERE id=$1`, [id]);
  if (!row) throw notFound();
  const membership = await findMembership(db, user.id, row.exchange_id);
  if (!membership) throw notFound();
  request.membership = membership;
  return membership;
}
