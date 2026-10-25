import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { addListedMember, createExchange } from "../support/fixtures.js";

// Drives the web console's main /api flows against a real database, so changes underneath (multi-tenancy,
// scoping, the worker) can't silently break the console. This is the only test file that bootstraps the
// legacy exchange.

interface Session { cookie: string; csrf: string }

let app: FastifyInstance;
let owner: Session;
let member: Session;
let jakeId: string;
let ownerStockId: string;
let ownerUserId: string;

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
    ownerUserId = session.user.id;
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

describe("legacy /api with a second exchange on the server", () => {
  let x: { exchangeId: string; seasonId: string };
  let xListing: string;
  let xOnlyUser: string;
  let xPrediction: string;

  beforeAll(async () => {
    x = await createExchange(pool);
    ({ userId: xOnlyUser, listingId: xListing } = await addListedMember(pool, x.exchangeId, x.seasonId, "XONE"));
    // The console owner is listed on the other exchange too, under the same ticker.
    await pool.query("INSERT INTO memberships(exchange_id,user_id,role,listing_consent_at) VALUES ($1,$2,'ADMIN',now())", [x.exchangeId, ownerUserId]);
    const ownerInX = await pool.query<{ id: string }>(
      `INSERT INTO listings(exchange_id,display_name,ticker,owner_user_id,is_active,claimed_at,consented_at)
       VALUES ($1,'Owner elsewhere','OWNR',$2,true,now(),now()) RETURNING id`, [x.exchangeId, ownerUserId]
    );
    await pool.query("INSERT INTO market_pools(season_id,stock_id) VALUES ($1,$2)", [x.seasonId, ownerInX.rows[0]!.id]);
    await pool.query("INSERT INTO feed_events(season_id,kind,actor_id,subject_stock_id,payload) VALUES ($1,'TRADE',$2,$3,'{}')", [x.seasonId, ownerUserId, xListing]);
    await pool.query("INSERT INTO glossary_entries(exchange_id,phrase,explanation,created_by) VALUES ($1,'x lore','Only on the other exchange',$2)", [x.exchangeId, ownerUserId]);
    const prediction = await pool.query<{ id: string }>(
      "INSERT INTO prediction_markets(season_id,creator_id,question,closes_at) VALUES ($1,$2,'Will the other exchange notice?',now()+interval '1 day') RETURNING id",
      [x.seasonId, ownerUserId]
    );
    xPrediction = prediction.rows[0]!.id;
    await pool.query("INSERT INTO notifications(exchange_id,user_id,kind,payload) VALUES ($1,$2,'OTHER_EXCHANGE','{}')", [x.exchangeId, ownerUserId]);
  });

  it("shows only the Default exchange's data, without duplicating someone listed on both", async () => {
    const session = (await call(owner, "GET", "/api/auth/session")).json();
    expect(session.user).toMatchObject({ stockId: ownerStockId, ticker: "OWNR" });

    const tickers = (items: Array<{ ticker: string }>) => items.map((item) => item.ticker).sort();
    expect(tickers((await call(owner, "GET", "/api/market")).json().stocks)).toEqual(["JAKE", "OWNR"]);
    expect(tickers((await call(owner, "GET", "/api/admin/roster")).json().people)).toEqual(["JAKE", "OWNR"]);
    const leaderboards = (await call(owner, "GET", "/api/leaderboards")).json();
    expect(tickers(leaderboards.aura)).toEqual(["JAKE", "OWNR"]);
    expect(tickers(leaderboards.wealth)).toEqual(["JAKE", "OWNR"]);

    const feed = (await call(owner, "GET", "/api/feed")).json().items as Array<{ id: string; subject: { ticker: string } | null }>;
    expect(new Set(feed.map((item) => item.id)).size).toBe(feed.length);
    expect(feed.some((item) => item.subject?.ticker === "XONE")).toBe(false);

    const glossary = (await call(owner, "GET", "/api/admin/glossary")).json().entries as Array<{ phrase: string }>;
    expect(glossary.map((entry) => entry.phrase)).not.toContain("x lore");
    const predictions = (await call(owner, "GET", "/api/predictions")).json().items as Array<{ id: string }>;
    expect(predictions.map((item) => item.id)).not.toContain(xPrediction);
    const notifications = (await call(owner, "GET", "/api/notifications")).json().items as Array<{ kind: string }>;
    expect(notifications.map((item) => item.kind)).not.toContain("OTHER_EXCHANGE");

    const exported = (await call(owner, "GET", "/api/admin/export")).json();
    expect(tickers(exported.people)).toEqual(["JAKE", "OWNR"]);
    expect(exported.seasons.every((season: { exchange_id: string }) => season.exchange_id !== x.exchangeId)).toBe(true);
    expect(exported.users.map((user: { id: string }) => user.id)).not.toContain(xOnlyUser);
  });

  it("refuses to act on the other exchange's ids", async () => {
    const refused = [
      await call(owner, "POST", "/api/trades/preview", { stockId: xListing, side: "BUY", quantity: 1 }),
      await call(owner, "POST", "/api/trades/quote", { stockId: xListing, side: "BUY", quantity: 1 }),
      await call(owner, "POST", "/api/limit-orders", { stockId: xListing, side: "BUY", quantity: 1, limitPrice: 50 }),
      await call(owner, "GET", `/api/stocks/${xListing}/history`),
      await call(owner, "POST", `/api/admin/roster/${xListing}/invite`, {}),
      await call(owner, "POST", `/api/admin/roster/${xListing}/delist`, {}),
      await call(owner, "POST", `/api/admin/users/${xOnlyUser}/reset-code`, {}),
      await call(member, "POST", "/api/aura-events", { subjectId: xListing, explanation: "Filed from the wrong exchange" }),
      await call(member, "POST", `/api/predictions/${xPrediction}/bet`, { side: "YES", amount: 10 }),
      await call(owner, "POST", "/api/options/quote", { stockId: xListing, optionType: "CALL", strike: 100, quantity: 1, duration: "ONE_DAY" })
    ];
    expect(refused.map((response) => response.statusCode)).toEqual(Array(refused.length).fill(404));

    const resolve = await call(owner, "POST", `/api/predictions/${xPrediction}/resolve`, { outcome: "CANCEL" });
    expect(resolve.statusCode).toBe(409);
    const untouched = await pool.query(
      "SELECT (SELECT status FROM prediction_markets WHERE id=$1) AS prediction, (SELECT is_active FROM listings WHERE id=$2) AS listed",
      [xPrediction, xListing]
    );
    expect(untouched.rows[0]).toEqual({ prediction: "OPEN", listed: true });
  });
});
