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

export interface ListedMember {
  userId: string;
  token: string;
  client: ReturnType<typeof v1Client>;
  listingId: string;
  ticker: string;
}

/** An exchange whose members all joined by invite and IPO'd, through the real /v1 routes. The first is the admin. */
export async function listedExchange(app: FastifyInstance, db: Pick<Pool, "query">, tickers: string[]): Promise<{ exchangeId: string; members: ListedMember[] }> {
  const [first] = tickers;
  const admin = await createAppUser(db, first!);
  const adminClient = v1Client(app, admin.token);
  const exchangeId = (await adminClient.post("/exchanges", { name: `${first} & friends`, timezone: "America/New_York" })).json().id as string;
  const code = (await adminClient.post(`/exchanges/${exchangeId}/invites`)).json().code as string;
  const members: ListedMember[] = [];
  for (const [index, ticker] of tickers.entries()) {
    const user = index === 0 ? admin : await createAppUser(db, ticker);
    const client = index === 0 ? adminClient : v1Client(app, user.token);
    if (index > 0) await client.post(`/invites/${code}/accept`);
    const listing = await client.post(`/exchanges/${exchangeId}/listing`, { ticker, consent: true });
    if (listing.statusCode !== 201) throw new Error(`IPO of ${ticker} failed: ${listing.body}`);
    members.push({ userId: user.userId, token: user.token, client, listingId: listing.json().id, ticker });
  }
  return { exchangeId, members };
}
