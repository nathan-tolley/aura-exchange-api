import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { one } from "../../src/db.js";
import { signAccessToken } from "../../src/services/token-service.js";

/** A signed-in app user, made directly in the database (the email-code flow has its own tests). */
export async function createAppUser(db: Pick<Pool, "query">, name = "Trader"): Promise<{ userId: string; token: string; email: string }> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`;
  const user = await one<{ id: string }>(db, "INSERT INTO users(email,display_name) VALUES ($1,$2) RETURNING id", [email, name]);
  return { userId: user.id, token: await signAccessToken(user.id), email };
}

/** Calls /v1 as one user, with a fresh Idempotency-Key on every write. */
export function v1Client(app: FastifyInstance, token: string) {
  const headers = (write: boolean) => ({ authorization: `Bearer ${token}`, ...(write ? { "idempotency-key": randomUUID() } : {}) });
  return {
    get: (url: string) => app.inject({ method: "GET", url: `/v1${url}`, headers: headers(false) }),
    post: (url: string, payload?: Record<string, unknown>) => app.inject({ method: "POST", url: `/v1${url}`, payload: payload ?? {}, headers: headers(true) }),
    delete: (url: string) => app.inject({ method: "DELETE", url: `/v1${url}`, headers: headers(true) })
  };
}
