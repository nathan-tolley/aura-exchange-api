import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { createAppUser, listedExchange, v1Client, type ListedMember } from "../support/v1-client.js";
import { expectResponseMatchesSpec } from "./openapi.js";

const NOON_IN_NEW_YORK = new Date("2026-10-24T16:00:00Z");
let app: FastifyInstance;
let exchangeId: string;
let members: ListedMember[];

beforeAll(async () => {
  app = await buildApp({ logger: false, v1: { now: () => NOON_IN_NEW_YORK } });
  ({ exchangeId, members } = await listedExchange(app, pool, ["JAKE", "MIAA", "NATE"]));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("GET /v1/exchanges/{id}/market", () => {
  it("lists every listing with freshness, the index and whether trading is open", async () => {
    const response = await members[0]!.client.get(`/exchanges/${exchangeId}/market`);
    expect(response.statusCode).toBe(200);
    expectResponseMatchesSpec("get", "/exchanges/{exchangeId}/market", 200, response.json());
    const market = response.json();
    expect(market).toMatchObject({
      exchangeId, marketState: "OPEN", nextChangeAt: "2026-10-25T02:00:00Z", asOf: "2026-10-24T16:00:00Z",
      index: { name: "AURA", value: "100.00", changePct: "0.00" }, queuedEventsCount: 0, tradingEnabled: true
    });
    expect(market.listings.map((listing: { ticker: string }) => listing.ticker)).toEqual(["$JAKE", "$MIAA", "$NATE"]);
    expect(market.listings[0]).toMatchObject({
      price: "100.00", changeAbs: "0.00", changePct: "0.00", state: "ACTIVE", badges: [], sparkline: ["100.00"], isMine: true, myPosition: null
    });
    expect(market.listings[1].isMine).toBe(false);
  });

  it("flags penny stocks and halted listings", async () => {
    const { exchangeId: otherId, members: others } = await listedExchange(app, pool, ["PENY", "HALT", "OKAY"]);
    await pool.query("UPDATE market_pools SET credit_reserve=16000 WHERE stock_id=$1", [others[0]!.listingId]);
    await pool.query("UPDATE market_pools SET halted_until=now()+interval '5 minutes' WHERE stock_id=$1", [others[1]!.listingId]);
    const listings = (await others[2]!.client.get(`/exchanges/${otherId}/market`)).json().listings;
    expect(listings.find((listing: { ticker: string }) => listing.ticker === "$PENY")).toMatchObject({ price: "4.00", badges: ["OTC_PINK"] });
    expect(listings.find((listing: { ticker: string }) => listing.ticker === "$HALT").state).toBe("HALTED");
  });

  it("is members only", async () => {
    const outsider = v1Client(app, (await createAppUser(pool)).token);
    const response = await outsider.get(`/exchanges/${exchangeId}/market`);
    expect(response.statusCode).toBe(403);
    expectResponseMatchesSpec("get", "/exchanges/{exchangeId}/market", 403, response.json());
  });
});

describe("GET /v1/listings/{id}", () => {
  it("returns the stock page with freshness and the day's numbers", async () => {
    const response = await members[0]!.client.get(`/listings/${members[1]!.listingId}`);
    expect(response.statusCode).toBe(200);
    expectResponseMatchesSpec("get", "/listings/{listingId}", 200, response.json());
    expect(response.json()).toMatchObject({
      ticker: "$MIAA", price: "100.00", prevClose: "100.00", open: "100.00", dayHigh: "100.00", dayLow: "100.00",
      seasonHigh: "100.00", seasonLow: "100.00", volume: "0", shortInterestPct: "0.00", borrowFeeDailyPct: "0.10",
      halt: null, events: [], lastTradeAt: null, marketState: "OPEN"
    });
  });

  it("answers another exchange's listing with 404", async () => {
    const outsider = v1Client(app, (await createAppUser(pool)).token);
    const response = await outsider.get(`/listings/${members[0]!.listingId}`);
    expect(response.statusCode).toBe(404);
    expectResponseMatchesSpec("get", "/listings/{listingId}", 404, response.json());
  });
});

describe("GET /v1/listings/{id}/candles", () => {
  it("returns candles for each range", async () => {
    for (const [range, interval] of [["1D", "5m"], ["1W", "1h"], ["1M", "1d"], ["SEASON", "1d"]] as const) {
      const response = await members[0]!.client.get(`/listings/${members[2]!.listingId}/candles?range=${range}`);
      expect(response.statusCode, range).toBe(200);
      expectResponseMatchesSpec("get", "/listings/{listingId}/candles", 200, response.json());
      expect(response.json()).toMatchObject({ interval, markers: [], prevClose: "100.00" });
      expect(response.json().candles[0]).toMatchObject({ o: "100.00", h: "100.00", l: "100.00", c: "100.00", v: "0" });
    }
  });
});
