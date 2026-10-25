import { Decimal } from "decimal.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { listedExchange, type ListedMember } from "../support/v1-client.js";
import { expectResponseMatchesSpec } from "./openapi.js";

const NOON_IN_NEW_YORK = new Date("2026-10-24T16:00:00Z");
let app: FastifyInstance;
let exchangeId: string;
let jake: ListedMember;
let mia: ListedMember;
let nate: ListedMember;

beforeAll(async () => {
  app = await buildApp({ logger: false, v1: { now: () => NOON_IN_NEW_YORK } });
  const listed = await listedExchange(app, pool, ["JAKE", "MIAA", "NATE"]);
  exchangeId = listed.exchangeId;
  [jake, mia, nate] = listed.members as [ListedMember, ListedMember, ListedMember];
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const quote = (member: ListedMember, listing: ListedMember, side: string, quantity: string, extra: Record<string, unknown> = {}) =>
  member.client.post("/quotes", { listingId: listing.listingId, side, quantity, ...extra });

async function buy(member: ListedMember, listing: ListedMember, side: string, quantity: string) {
  const quoted = await quote(member, listing, side, quantity);
  expect(quoted.statusCode, quoted.body).toBe(201);
  const traded = await member.client.post("/trades", { quoteId: quoted.json().id });
  expect(traded.statusCode, traded.body).toBe(201);
  return { quote: quoted.json(), trade: traded.json() };
}

describe("quotes and trades", () => {
  it("quotes a buy with the fee, the impact and the cash left, then fills it at exactly that price", async () => {
    const quoted = await quote(jake, mia, "BUY", "20");
    expect(quoted.statusCode).toBe(201);
    expectResponseMatchesSpec("post", "/quotes", 201, quoted.json());
    const q = quoted.json();
    expect(q).toMatchObject({ listingId: mia.listingId, side: "BUY", quantity: "20", feeRate: "0.50", currentPrice: "100.00", previous: null, short: null, marketState: "OPEN" });
    expect(new Decimal(q.total).toFixed(2)).toBe(new Decimal(q.gross).plus(q.fee).toFixed(2));
    expect(q.cashAfter).toBe(new Decimal(10_000).minus(q.total).toFixed(2));

    const traded = await jake.client.post("/trades", { quoteId: q.id });
    expect(traded.statusCode).toBe(201);
    expectResponseMatchesSpec("post", "/trades", 201, traded.json());
    expect(traded.json()).toMatchObject({ quoteId: q.id, side: "BUY", quantity: "20", price: q.price, total: q.total, cashAfter: q.cashAfter });
    expect(traded.json().listing).toMatchObject({ id: mia.listingId, ticker: "$MIAA" });
    expect(traded.json().position).toMatchObject({ side: "LONG", status: "OPEN", quantity: "20", short: null });

    const market = (await jake.client.get(`/exchanges/${exchangeId}/market`)).json();
    const row = market.listings.find((listing: { id: string }) => listing.id === mia.listingId);
    expect(row.myPosition).toEqual({ side: "LONG", quantity: "20" });
    expect(new Decimal(row.price).gt(100)).toBe(true);
  });

  it("refuses a used quote as stale, saying the old and new price", async () => {
    const { quote: used } = await buy(nate, jake, "BUY", "5");
    const again = await nate.client.post("/trades", { quoteId: used.id });
    expect(again.statusCode).toBe(409);
    expectResponseMatchesSpec("post", "/trades", 409, again.json());
    expect(again.json().error).toMatchObject({ code: "QUOTE_STALE", action: "REQUOTE", retryable: true, params: { oldPrice: used.price } });
  });

  it("refuses a quote whose reserves moved, and a requote shows the difference", async () => {
    const first = (await quote(mia, jake, "BUY", "10")).json();
    await buy(nate, jake, "BUY", "30");
    const stale = await mia.client.post("/trades", { quoteId: first.id });
    expect(stale.statusCode).toBe(409);
    const params = stale.json().error.params;
    expect(params.oldPrice).toBe(first.price);
    expect(new Decimal(params.newPrice).gt(params.oldPrice)).toBe(true);
    expect(new Decimal(params.changePct).gt(0)).toBe(true);

    const requote = await quote(mia, jake, "BUY", "10", { previousQuoteId: first.id });
    expectResponseMatchesSpec("post", "/quotes", 201, requote.json());
    expect(requote.json().previous).toMatchObject({ quoteId: first.id, price: first.price, total: first.total });
    expect(new Decimal(requote.json().previous.changePct).gt(0)).toBe(true);
  });

  it("explains a buy it can't afford, with the largest quantity that would go through", async () => {
    const response = await quote(mia, nate, "BUY", "300");
    expect(response.statusCode).toBe(422);
    expectResponseMatchesSpec("post", "/quotes", 422, response.json());
    const { code, action, params } = response.json().error;
    expect({ code, action }).toEqual({ code: "INSUFFICIENT_CASH", action: "REDUCE_QUANTITY" });
    expect(new Decimal(params.shortBy).toFixed(2)).toBe(new Decimal(params.needed).minus(params.available).toFixed(2));
    // W05 shows the receipt beside the fix: what 300 would cost, and when the next stimulus check lands (Monday 9 am in New York).
    expect(params).toMatchObject({ feeRate: "0.50", total: params.needed, nextStimulusAt: "2026-10-26T13:00:00Z" });
    expect(new Decimal(params.gross).plus(params.fee).toFixed(2)).toBe(params.total);
    expect(new Decimal(params.price).mul(300).minus(params.gross).abs().lte("1.50")).toBe(true);
    expect((await quote(mia, nate, "BUY", params.maxQuantity)).statusCode).toBe(201);
    expect((await quote(mia, nate, "BUY", new Decimal(params.maxQuantity).plus("0.0001").toString())).statusCode).toBe(422);
  });

  it("caps one order at 10% of the pool", async () => {
    const response = await quote(mia, nate, "BUY", "500");
    expect(response.json().error).toMatchObject({ code: "ORDER_TOO_LARGE", params: { maxQuantity: "400" } });
  });

  it("never lets you trade your own stock", async () => {
    const response = await quote(jake, jake, "BUY", "1");
    expect(response.statusCode).toBe(403);
    expectResponseMatchesSpec("post", "/quotes", 403, response.json());
    expect(response.json().error).toMatchObject({ code: "SELF_TRADE", params: { ticker: "$JAKE" } });
  });

  it("won't sell more than you hold, or short what you're long", async () => {
    const sell = await quote(jake, mia, "SELL", "25");
    expect(sell.json().error).toMatchObject({ code: "INSUFFICIENT_SHARES", params: { available: "20", maxQuantity: "20" } });
    const short = await quote(jake, mia, "SHORT", "5");
    expect(short.json().error.code).toBe("OPPOSITE_POSITION");
    expect(short.json().error.params.positionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shorts with collateral and a liquidation price, then covers", async () => {
    const quoted = (await quote(mia, nate, "SHORT", "10")).json();
    // Margin is half the unrounded gross, so it can differ from half the 2-dp gross by a cent.
    expect(new Decimal(quoted.short.collateralRequired).minus(new Decimal(quoted.gross).mul("0.5")).abs().lte("0.01")).toBe(true);
    const { trade } = await buy(mia, nate, "SHORT", "10");
    expect(trade.position).toMatchObject({ side: "SHORT", quantity: "10" });
    expect(trade.position.short).toMatchObject({ warningRatioPct: "140.00", maintenanceRatioPct: "125.00", liquidationPrice: quoted.short.liquidationPrice });
    expect(new Decimal(trade.position.short.collateralRatioPct).gt(140)).toBe(true);
    const covered = await buy(mia, nate, "COVER", "10");
    expect(covered.trade.position).toBeNull();
  });

  it("caps shorts at 20% of equity per stock", async () => {
    const response = await quote(nate, mia, "SHORT", "30");
    expect(response.json().error).toMatchObject({ code: "SHORT_CAP", params: { capPct: "20.00", feeRate: "0.50" } });
    const { params } = response.json().error;
    expect(new Decimal(params.gross).minus(params.fee).toFixed(2)).toBe(params.total);
    expect((await quote(nate, mia, "SHORT", params.maxQuantity)).statusCode).toBe(201);
  });

  it("refuses halted stocks", async () => {
    await pool.query("UPDATE market_pools SET halted_until=now()+interval '5 minutes' WHERE stock_id=$1", [nate.listingId]);
    const response = await quote(jake, nate, "BUY", "1");
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "LISTING_HALTED", action: "WAIT" });
    expect(response.json().error.params.resumesAt).toMatch(/Z$/);
    await pool.query("UPDATE market_pools SET halted_until=NULL WHERE stock_id=$1", [nate.listingId]);
  });

  it("keeps the ledger balanced and every pool's constant product", async () => {
    const unbalanced = await pool.query("SELECT transaction_id FROM cash_ledger_entries GROUP BY transaction_id HAVING SUM(amount) <> 0");
    expect(unbalanced.rows).toEqual([]);
    const trades = await pool.query<{ share_reserve: string; credit_reserve: string }>(
      "SELECT share_reserve::text, credit_reserve::text FROM market_pools WHERE exchange_id=$1", [exchangeId]
    );
    for (const row of trades.rows) {
      const k = new Decimal(row.share_reserve).mul(row.credit_reserve);
      expect(k.div(4000 * 400_000).minus(1).abs().lt("0.000001")).toBe(true);
    }
  });
});

describe("market hours and the IPO-day rule", () => {
  it("refuses market orders while closed and outside regular hours", async () => {
    for (const [time, code, params] of [
      ["2026-10-24T07:30:00Z", "MARKET_CLOSED", { opensAt: "2026-10-24T11:00:00Z", queuedEvents: "0" }],
      ["2026-10-24T12:00:00Z", "ORDER_TYPE_NOT_ALLOWED", { marketState: "PRE" }],
      ["2026-10-25T03:00:00Z", "ORDER_TYPE_NOT_ALLOWED", { marketState: "AFTER" }]
    ] as const) {
      const clocked = await buildApp({ logger: false, v1: { now: () => new Date(time) } });
      try {
        const response = await clocked.inject({
          method: "POST", url: "/v1/quotes", payload: { listingId: mia.listingId, side: "BUY", quantity: "1" },
          headers: { authorization: `Bearer ${jake.token}`, "idempotency-key": crypto.randomUUID() }
        });
        expect(response.statusCode, time).toBe(409);
        expectResponseMatchesSpec("post", "/quotes", 409, response.json());
        expect(response.json().error).toMatchObject({ code, params });
      } finally {
        await clocked.close();
      }
    }
  });

  it("keeps trading shut until enough members are listed", async () => {
    const [first, second] = (await listedExchange(app, pool, ["ONEE", "TWOO"])).members as [ListedMember, ListedMember];
    const response = await quote(first, second, "BUY", "1");
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "TRADING_NOT_OPEN", params: { listedCount: "2", minListingsToOpen: "3" } });
  });
});
