import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type Db = Pick<Pool | PoolClient, "query">;

/** A first request still running after this long is presumed dead, and its key is released for a retry. */
export const IN_FLIGHT_TIMEOUT_SECONDS = 300;

export interface StoredKey {
  request_hash: string;
  status_code: number | null;
  response_body: string | null;
}

/** JSON with object keys sorted, so equal bodies hash equally whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash("sha256").update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`).digest("hex");
}

/** Claims the key for this request. Returns null when claimed, or the row already holding the key. */
export async function reserveKey(db: Db, scope: string, key: string, method: string, path: string, hash: string): Promise<StoredKey | null> {
  await db.query(
    `DELETE FROM idempotency_keys
      WHERE scope=$1 AND idempotency_key=$2
        AND (expires_at<=now() OR (status_code IS NULL AND created_at<=now()-make_interval(secs => $3)))`,
    [scope, key, IN_FLIGHT_TIMEOUT_SECONDS]
  );
  const inserted = await db.query(
    `INSERT INTO idempotency_keys(scope,idempotency_key,method,path,request_hash) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (scope,idempotency_key) DO NOTHING RETURNING 1`,
    [scope, key, method, path, hash]
  );
  if (inserted.rowCount) return null;
  const existing = await db.query<StoredKey>(
    "SELECT request_hash,status_code,response_body FROM idempotency_keys WHERE scope=$1 AND idempotency_key=$2",
    [scope, key]
  );
  // Released between the insert and the read: report it as in flight so the client retries.
  return existing.rows[0] ?? { request_hash: hash, status_code: null, response_body: null };
}

export async function completeKey(db: Db, scope: string, key: string, statusCode: number, body: string | null): Promise<void> {
  await db.query(
    "UPDATE idempotency_keys SET status_code=$3,response_body=$4,completed_at=now() WHERE scope=$1 AND idempotency_key=$2",
    [scope, key, statusCode, body]
  );
}

/** Forgets a key whose request failed on the server, so the same key can be retried. */
export async function releaseKey(db: Db, scope: string, key: string): Promise<void> {
  await db.query("DELETE FROM idempotency_keys WHERE scope=$1 AND idempotency_key=$2 AND status_code IS NULL", [scope, key]);
}

export async function purgeExpiredKeys(db: Db): Promise<number> {
  const result = await db.query("DELETE FROM idempotency_keys WHERE expires_at<=now()");
  return result.rowCount ?? 0;
}
