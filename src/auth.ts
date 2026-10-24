import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { forbidden, unauthorized } from "./errors.js";
import { config } from "./config.js";
import type { Role, SessionUser } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: SessionUser | null;
  }
}

const SESSION_COOKIE = "aura_session";
const secureCookies = new URL(config.APP_ORIGIN).protocol === "https:";

export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
export const opaqueToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export async function issueSession(client: PoolClient, userId: string, context?: { userAgent?: string; ipAddress?: string }): Promise<{ token: string; csrfToken: string }> {
  const token = opaqueToken();
  const csrfToken = opaqueToken(24);
  await client.query(
    `INSERT INTO sessions(user_id, token_hash, csrf_token, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, now() + interval '14 days', $4, $5)`,
    [userId, hashToken(token), csrfToken, context?.userAgent?.slice(0, 500) ?? null, context?.ipAddress ?? null]
  );
  return { token, csrfToken };
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: secureCookies,
    sameSite: "strict",
    maxAge: 60 * 60 * 24 * 14
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/", sameSite: "strict", secure: secureCookies });
}

export async function loadSession(request: FastifyRequest): Promise<void> {
  request.auth = null;
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return;

  const result = await pool.query<{
    id: string;
    username: string;
    role: Role;
    csrf_token: string;
    stock_id: string | null;
    display_name: string | null;
    ticker: string | null;
  }>(
    `SELECT u.id, u.username::text, u.role, s.csrf_token,
            ps.id AS stock_id, ps.display_name, ps.ticker::text
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN person_stocks ps ON ps.owner_user_id = u.id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND s.revoked_at IS NULL`,
    [hashToken(token)]
  );
  const row = result.rows[0];
  if (!row) return;
  await pool.query("UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1 AND last_seen_at<now()-interval '5 minutes'", [hashToken(token)]);
  request.auth = {
    id: row.id,
    username: row.username,
    role: row.role,
    csrfToken: row.csrf_token,
    stockId: row.stock_id,
    displayName: row.display_name,
    ticker: row.ticker
  };
}

export interface GuardOptions {
  roles?: Role[];
  csrf?: boolean;
}

export function guard(options: GuardOptions = {}) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.auth) throw unauthorized();
    if (options.roles && !options.roles.includes(request.auth.role)) throw forbidden();
    if (options.csrf && request.headers["x-csrf-token"] !== request.auth.csrfToken) {
      throw forbidden("Invalid CSRF token");
    }
  };
}

