import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db.js";

// Drives the web console's main /api flows against a real database, so changes underneath (multi-tenancy,
// scoping, the worker) can't silently break the console. This is the only test file that bootstraps the
// legacy exchange.

interface Session { cookie: string; csrf: string }

let app: FastifyInstance;
let owner: Session;
let member: Session;
let jakeId: string;
let ownerStockId: string;

function sessionFrom(response: LightMyRequestResponse): Session {
  const cookie = response.cookies.find((item) => item.name === "aura_session");
  if (!cookie) throw new Error(`No session cookie (status ${response.statusCode}): ${response.body}`);
  return { cookie: cookie.value, csrf: response.json().csrfToken };
}

const call = (session: Session | null, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) => app.inject({
  method,
  url,
  payload,
  cookies: session ? { aura_session: session.cookie } : {},
  headers: session && method !== "GET" ? { "x-csrf-token": session.csrf } : {}
});

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("legacy /api console flows", () => {
  it("bootstraps the owner, their stock and season 1", async () => {
    expect((await call(null, "GET", "/api/setup/status")).json()).toEqual({ needsSetup: true });
    const response = await call(null, "POST", "/api/setup/bootstrap", {
      setupToken: "change-this-setup-token", displayName: "Exchange Owner", ticker: "OWNR",
      username: "owner", password: "correct-horse-battery", consent: true
    });
    expect(response.statusCode).toBe(201);
    owner = sessionFrom(response);
    const session = (await call(owner, "GET", "/api/auth/session")).json();
    expect(session.user).toMatchObject({ username: "owner", role: "OWNER", ticker: "OWNR" });
    ownerStockId = session.user.stockId;
    expect((await call(null, "GET", "/api/setup/status")).json()).toEqual({ needsSetup: false });
  });

  it("adds a person to the roster and lets them claim it", async () => {
    const roster = await call(owner, "POST", "/api/admin/roster", { displayName: "Jake", ticker: "JAKE" });
    expect(roster.statusCode).toBe(201);
    jakeId = roster.json().id;
    const claim = await call(null, "POST", "/api/auth/claim", {
      username: "jake", password: "another-long-password", claimCode: roster.json().claimCode, consent: true
    });
    expect(claim.statusCode).toBe(201);
    member = sessionFrom(claim);
    const people = (await call(owner, "GET", "/api/admin/roster")).json().people;
    expect(people.map((person: { ticker: string }) => person.ticker).sort()).toEqual(["JAKE", "OWNR"]);
  });

  it("lists the market", async () => {
    const market = (await call(member, "GET", "/api/market")).json();
    expect(market.stocks.map((stock: { ticker: string }) => stock.ticker)).toEqual(["JAKE", "OWNR"]);
    expect(market.stocks[0].price).toBeCloseTo(100, 6);
  });

  it("quotes and executes a trade, idempotently", async () => {
    const preview = await call(owner, "POST", "/api/trades/preview", { stockId: jakeId, side: "BUY", quantity: 5 });
    expect(preview.json()).toMatchObject({ canExecute: true });
    const quote = await call(owner, "POST", "/api/trades/quote", { stockId: jakeId, side: "BUY", quantity: 5 });
    expect(quote.statusCode).toBe(201);
    const idempotencyKey = randomUUID();
    const executed = await call(owner, "POST", "/api/trades/execute", { quoteId: quote.json().id, idempotencyKey });
    expect(executed.statusCode).toBe(201);
    const repeat = await call(owner, "POST", "/api/trades/execute", { quoteId: quote.json().id, idempotencyKey });
    expect(repeat.json()).toMatchObject({ tradeId: executed.json().tradeId, duplicate: true });
    const ownTrade = await call(member, "POST", "/api/trades/quote", { stockId: jakeId, side: "BUY", quantity: 1 });
    expect(ownTrade.statusCode).toBe(403);
  });

  it("shows the position in the portfolio", async () => {
    const portfolio = (await call(owner, "GET", "/api/portfolio")).json();
    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.positions[0]).toMatchObject({ ticker: "JAKE", longQty: 5 });
    expect(portfolio.cash).toBeLessThan(10_000);
  });

  it("places and cancels a limit order", async () => {
    const order = await call(owner, "POST", "/api/limit-orders", { stockId: jakeId, side: "BUY", quantity: 1, limitPrice: 50 });
    expect(order.statusCode).toBe(201);
    expect((await call(owner, "GET", "/api/limit-orders")).json().items).toHaveLength(1);
    expect((await call(owner, "POST", `/api/limit-orders/${order.json().id}/cancel`, {})).statusCode).toBe(200);
  });

  it("files an event and queues the judge", async () => {
    const filed = await call(member, "POST", "/api/aura-events", { subjectId: ownerStockId, explanation: "Brought snacks for the whole floor" });
    expect(filed.statusCode).toBe(202);
    const job = await pool.query("SELECT 1 FROM jobs WHERE type='JUDGE_AURA' AND payload->>'submissionId'=$1", [filed.json().id]);
    expect(job.rowCount).toBe(1);
  });

  it("serves the feed and the read-only views", async () => {
    const feed = (await call(member, "GET", "/api/feed")).json().items as Array<{ kind: string }>;
    expect(feed.map((item) => item.kind)).toEqual(expect.arrayContaining(["SEASON_STARTED", "MEMBER_JOINED", "TRADE"]));
    for (const url of ["/api/leaderboards", "/api/composite", `/api/stocks/${jakeId}/history`, "/api/notifications", "/api/options", "/api/predictions", "/api/aura-farming"]) {
      const response = await call(owner, "GET", url);
      expect(response.statusCode, url).toBe(200);
    }
    for (const url of ["/api/health", "/api/admin/glossary", "/api/moderation/review", "/api/admin/diagnostics/jobs"]) {
      expect((await call(owner, "GET", url)).statusCode, url).toBe(200);
    }
  });

  it("adds a glossary entry", async () => {
    const entry = await call(owner, "POST", "/api/admin/glossary", { phrase: "leg day", explanation: "A promise Jake makes on Mondays" });
    expect(entry.statusCode).toBe(201);
  });
});
