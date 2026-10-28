import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { config } from "../config.js";
import { maybeOne, one } from "../db.js";

type Db = Pick<Pool | PoolClient, "query">;

export const LOGIN_CODE_TTL_MINUTES = 10;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const LOGIN_CODES_PER_EMAIL_PER_HOUR = 5;

const codeKey = createHmac("sha256", config.AUTH_SECRET).update("aura login code v1").digest();

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function generateLoginCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Keyed, so a leaked table can't be brute-forced offline. */
export function hashLoginCode(email: string, code: string): string {
  return createHmac("sha256", codeKey).update(`${normalizeEmail(email)}\n${code}`).digest("hex");
}

export type IssueResult = { issued: true; id: string; code: string } | { issued: false; retryAfterSeconds: number };

/** Creates a fresh code for the email, superseding any earlier one, unless the email has had too many this hour. */
export async function issueLoginCode(db: Db, email: string, ipAddress: string | null): Promise<IssueResult> {
  const address = normalizeEmail(email);
  const recent = await one<{ count: number; oldest: Date | null }>(db,
    "SELECT COUNT(*)::int AS count, MIN(created_at) AS oldest FROM login_codes WHERE email=$1 AND created_at > now() - interval '1 hour'",
    [address]
  );
  if (recent.count >= LOGIN_CODES_PER_EMAIL_PER_HOUR && recent.oldest) {
    const retryAfterSeconds = Math.max(1, Math.ceil((recent.oldest.getTime() + 3_600_000 - Date.now()) / 1000));
    return { issued: false, retryAfterSeconds };
  }
  const code = generateLoginCode();
  await db.query("UPDATE login_codes SET expires_at=now() WHERE email=$1 AND consumed_at IS NULL AND expires_at > now()", [address]);
  const row = await one<{ id: string }>(db,
    `INSERT INTO login_codes(email,code_hash,expires_at,ip_address) VALUES ($1,$2,now() + make_interval(mins => $3),$4) RETURNING id`,
    [address, hashLoginCode(address, code), LOGIN_CODE_TTL_MINUTES, ipAddress]
  );
  return { issued: true, id: row.id, code };
}

/** Removes a code that never reached its inbox, so it doesn't count against the email's hourly limit. */
export async function withdrawLoginCode(db: Db, id: string): Promise<void> {
  await db.query("DELETE FROM login_codes WHERE id=$1 AND consumed_at IS NULL", [id]);
}

export type CheckResult = { ok: true } | { ok: false; reason: "INVALID"; attemptsLeft: number } | { ok: false; reason: "EXPIRED" };

/**
 * Checks a code against the email's latest one. Run it in a transaction that commits even when the check fails:
 * a wrong try must still count.
 */
export async function checkLoginCode(client: PoolClient, email: string, code: string): Promise<CheckResult> {
  const address = normalizeEmail(email);
  const latest = await maybeOne<{ id: string; code_hash: string; attempts: number; expired: boolean }>(client,
    `SELECT id, code_hash, attempts, expires_at <= now() AS expired FROM login_codes
      WHERE email=$1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [address]
  );
  if (!latest || latest.expired || latest.attempts >= LOGIN_CODE_MAX_ATTEMPTS) return { ok: false, reason: "EXPIRED" };
  const expected = Buffer.from(latest.code_hash, "hex");
  const actual = Buffer.from(hashLoginCode(address, code), "hex");
  if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
    await client.query("UPDATE login_codes SET consumed_at=now() WHERE id=$1", [latest.id]);
    return { ok: true };
  }
  await client.query("UPDATE login_codes SET attempts=attempts+1 WHERE id=$1", [latest.id]);
  return { ok: false, reason: "INVALID", attemptsLeft: LOGIN_CODE_MAX_ATTEMPTS - latest.attempts - 1 };
}

export interface AppUserRow {
  id: string;
  email: string | null;
  display_name: string | null;
  username: string | null;
  created_at: Date;
}

/** Signing in with a new email creates the account; there is no separate sign-up. */
export async function findOrCreateEmailUser(db: Db, email: string): Promise<AppUserRow> {
  const address = normalizeEmail(email);
  const displayName = (address.split("@")[0] ?? "").slice(0, 60) || "Trader";
  return one<AppUserRow>(db,
    `INSERT INTO users(email, display_name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET updated_at = now()
     RETURNING id, email::text, display_name, username::text, created_at`,
    [address, displayName]
  );
}
