import { Decimal } from "decimal.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { accounts, postLedgerTransaction } from "../../src/core/ledger.js";
import { pool, withTransaction } from "../../src/db.js";
import { activeSeason } from "../../src/services/exchange-service.js";
import { createAppUser, listedExchange, v1Client, type ListedMember } from "../support/v1-client.js";
import { expectResponseMatchesSpec } from "./openapi.js";

const NOON_IN_NEW_YORK = new Date("2026-10-24T16:00:00Z");
let app: FastifyInstance;
let exchangeId: string;
let trader: ListedMember;
let longOn: ListedMember;
let shortOn: ListedMember;

beforeAll(async () => {
  app = await buildApp({ logger: false, v1: { now: () => NOON_IN_NEW_YORK } });
  const listed = await listedExchange(app, pool, ["ANNA", "BOBB", "CARL"]);
  exchangeId = listed.exchangeId;
  [trader, longOn, shortOn] = listed.members as [ListedMember, ListedMember, ListedMember];
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function trade(listing: ListedMember, side: string, quantity: string) {
  const quote = await trader.client.post("/quotes", { listingId: listing.listingId, side, quantity });
  expect(quote.statusCode, quote.body).toBe(201);
  expect((await trader.client.post("/trades", { quoteId: quote.json().id })).statusCode).toBe(201);
}

describe("GET /v1/exchanges/{id}/portfolio", () => {
  it("starts as A$10,000 in cash and nothing else", async () => {
    const response = await trader.client.get(`/exchanges/${exchangeId}/portfolio`);
    expect(response.statusCode).toBe(200);
    expectResponseMatchesSpec("get", "/exchanges/{exchangeId}/portfolio", 200, response.json());
    expect(response.json()).toMatchObject({
      exchangeId, cash: "10000.00", reservedCash: "0.00", netWorth: "10000.00", seasonChangeAbs: "0.00", seasonChangePct: "0.00",
      dayChangeAbs: "0.00", positions: [], openOrders: [], canDeclareBankruptcy: false, marketState: "OPEN"
    });
  });

  it("marks longs and shorts to the pool and adds up to the net worth", async () => {
    await trade(longOn, "BUY", "20");
    await trade(shortOn, "SHORT", "10");
    const response = await trader.client.get(`/exchanges/${exchangeId}/portfolio`);
    expectResponseMatchesSpec("get", "/exchanges/{exchangeId}/portfolio", 200, response.json());
    const portfolio = response.json();
    expect(portfolio.positions.map((position: { listing: { ticker: string }; side: string }) => [position.listing.ticker, position.side]))
      .toEqual([["$BOBB", "LONG"], ["$CARL", "SHORT"]]);
    const short = portfolio.positions[1];
    expect(short.short).toMatchObject({ warningRatioPct: "140.00", maintenanceRatioPct: "125.00" });
    // Net worth = cash + long value + short collateral − the cost of buying the short back.
    const long = portfolio.positions[0];
    const expected = new Decimal(portfolio.cash).plus(long.marketValue).plus(short.short.collateral).plus(short.marketValue);
    expect(new Decimal(portfolio.netWorth).minus(expected).abs().lte("0.02")).toBe(true);
    // Fees make the round trip cost a little.
    expect(new Decimal(portfolio.seasonChangeAbs).lt(0)).toBe(true);
    expect(new Decimal(portfolio.dayChangeAbs).abs().gt(0)).toBe(true);
  });

  it("counts resting buy orders as reserved cash, not lost cash", async () => {
    const season = await activeSeason(pool, exchangeId);
    await withTransaction(async (client) => {
      const order = await client.query<{ id: string }>(
        "INSERT INTO limit_orders(season_id,user_id,stock_id,side,quantity,limit_price,reserved_cash) VALUES ($1,$2,$3,'BUY',1,50,50.25) RETURNING id",
        [season!.id, trader.userId, longOn.listingId]
      );
      await postLedgerTransaction(client, "LIMIT_RESERVE", "test reserve", [
        { accountKey: accounts.userCash(trader.userId, season!.id), amount: -50.25 },
        { accountKey: accounts.limitEscrow(order.rows[0]!.id, season!.id), amount: 50.25 }
      ]);
    });
    const before = (await trader.client.get(`/exchanges/${exchangeId}/portfolio`)).json();
    expectResponseMatchesSpec("get", "/exchanges/{exchangeId}/portfolio", 200, before);
    expect(before.reservedCash).toBe("50.25");
    expect(before.openOrders[0]).toMatchObject({ type: "LIMIT_BUY", quantity: "1", triggerPrice: "50.00", status: "RESTING", reservedCash: "50.25" });
  });

  it("is members only", async () => {
    const outsider = v1Client(app, (await createAppUser(pool)).token);
    const response = await outsider.get(`/exchanges/${exchangeId}/portfolio`);
    expect(response.statusCode).toBe(403);
    expectResponseMatchesSpec("get", "/exchanges/{exchangeId}/portfolio", 403, response.json());
  });
});
