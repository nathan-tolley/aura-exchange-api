import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { Pool, PoolClient } from "pg";
import { config } from "../config.js";
import { maybeOne } from "../db.js";

type Db = Pick<Pool | PoolClient, "query">;

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;

const ISSUER = "aura-exchange";
const AUDIENCE = "aura-app";
const accessKey = new Uint8Array(createHmac("sha256", config.AUTH_SECRET).update("aura access token v1").digest());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function signAccessToken(userId: string, issuedAt = new Date()): Promise<string> {
  const iat = Math.floor(issuedAt.getTime() / 1000);
  return new SignJWT({ typ: "access" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TOKEN_TTL_SECONDS)
    .setJti(randomUUID())
    .sign(accessKey);
}

/** The user id in a valid, unexpired access token, or null. */
export async function verifyAccessToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, accessKey, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    return payload.typ === "access" && typeof payload.sub === "string" && UUID.test(payload.sub) ? payload.sub : null;
  } catch {
    return null;
  }
}

const hashRefreshToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** A new access token and a new refresh token, in a new family unless one is given (rotation). */
export async function issueTokenPair(
  db: Db,
  userId: string,
  options: { familyId?: string; parentId?: string; userAgent?: string } = {}
): Promise<TokenPair> {
  const refreshToken = `rt_${randomBytes(32).toString("base64url")}`;
  await db.query(
    `INSERT INTO refresh_tokens(family_id,user_id,token_hash,parent_id,expires_at,user_agent)
     VALUES ($1,$2,$3,$4,now() + make_interval(days => $5),$6)`,
    [options.familyId ?? randomUUID(), userId, hashRefreshToken(refreshToken), options.parentId ?? null, REFRESH_TOKEN_TTL_DAYS, options.userAgent?.slice(0, 500) ?? null]
  );
  return { accessToken: await signAccessToken(userId), refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

export type RotateResult =
  | { ok: true; userId: string; pair: TokenPair }
  | { ok: false; reason: "UNKNOWN" | "EXPIRED" | "REVOKED" | "REUSED" };

/**
 * Trades a refresh token for a new pair. A token that was already used means someone else holds a copy, so the
 * whole family is revoked. Run in a transaction that commits even on failure, so the revocation sticks.
 */
export async function rotateRefreshToken(client: PoolClient, refreshToken: string, userAgent?: string): Promise<RotateResult> {
  const row = await maybeOne<{ id: string; family_id: string; user_id: string; used_at: Date | null; revoked_at: Date | null; expired: boolean }>(client,
    "SELECT id,family_id,user_id,used_at,revoked_at,expires_at <= now() AS expired FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE",
    [hashRefreshToken(refreshToken)]
  );
  if (!row) return { ok: false, reason: "UNKNOWN" };
  if (row.revoked_at) return { ok: false, reason: "REVOKED" };
  if (row.used_at) {
    await client.query(
      "UPDATE refresh_tokens SET revoked_at=now(),revoked_reason='REUSE' WHERE family_id=$1 AND revoked_at IS NULL",
      [row.family_id]
    );
    return { ok: false, reason: "REUSED" };
  }
  if (row.expired) return { ok: false, reason: "EXPIRED" };
  await client.query("UPDATE refresh_tokens SET used_at=now() WHERE id=$1", [row.id]);
  const pair = await issueTokenPair(client, row.user_id, { familyId: row.family_id, parentId: row.id, userAgent });
  return { ok: true, userId: row.user_id, pair };
}

/** Signs out one device: revokes the family the refresh token belongs to, if it is the user's. */
export async function revokeFamily(db: Db, refreshToken: string, userId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE refresh_tokens SET revoked_at=now(),revoked_reason='LOGOUT'
      WHERE revoked_at IS NULL
        AND family_id=(SELECT family_id FROM refresh_tokens WHERE token_hash=$1 AND user_id=$2)`,
    [hashRefreshToken(refreshToken), userId]
  );
  return (result.rowCount ?? 0) > 0;
}
