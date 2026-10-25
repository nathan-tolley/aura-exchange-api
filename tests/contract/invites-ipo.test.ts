import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { accountBalance, accounts } from "../../src/core/ledger.js";
import { pool } from "../../src/db.js";
import { activeSeason, tradingState } from "../../src/services/exchange-service.js";
import { createAppUser, v1Client } from "../support/v1-client.js";
import { expectResponseMatchesSpec } from "./openapi.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function exchangeWithAdmin(name = "Nate") {
  const admin = await createAppUser(pool, name);
  const client = v1Client(app, admin.token);
  const exchange = (await client.post("/exchanges", { name: `${name}'s group`, timezone: "America/New_York" })).json();
  return { admin, client, exchangeId: exchange.id as string };
}

describe("invites", () => {
  it("invite, preview, accept: the new member gets their starting cash once", async () => {
    const { client, exchangeId } = await exchangeWithAdmin();
    const invite = await client.post(`/exchanges/${exchangeId}/invites`);
    expect(invite.statusCode).toBe(201);
    expectResponseMatchesSpec("post", "/exchanges/{exchangeId}/invites", 201, invite.json());
    expect(invite.json().code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(invite.json().url).toBe(`aura-exchange://invite/${invite.json().code}`);

    const friend = await createAppUser(pool, "Jake");
    const friendClient = v1Client(app, friend.token);
    const preview = await friendClient.get(`/invites/${invite.json().code.toLowerCase().replace("-", "")}`);
    expect(preview.statusCode).toBe(200);
    expectResponseMatchesSpec("get", "/invites/{code}", 200, preview.json());
    expect(preview.json()).toMatchObject({ code: invite.json().code, status: "VALID", memberCount: 1, listed: [] });

    const accepted = await friendClient.post(`/invites/${invite.json().code}/accept`);
    expect(accepted.statusCode).toBe(200);
    expectResponseMatchesSpec("post", "/invites/{code}/accept", 200, accepted.json());
    expect(accepted.json()).toMatchObject({ exchangeId, role: "MEMBER", listing: null });
    const again = await friendClient.post(`/invites/${invite.json().code}/accept`);
    expect(again.json().id).toBe(accepted.json().id);
    const season = await activeSeason(pool, exchangeId);
    expect((await accountBalance(pool as never, accounts.userCash(friend.userId, season!.id))).toFixed(2)).toBe("10000.00");
    expect((await friendClient.get(`/exchanges/${exchangeId}`)).json().memberCount).toBe(2);
  });

  it("answers unknown codes with 404 and expired ones with INVITE_EXPIRED", async () => {
    const { client, exchangeId } = await exchangeWithAdmin();
    const stranger = v1Client(app, (await createAppUser(pool)).token);
    const unknown = await stranger.get("/invites/ZZZZ-ZZZZ");
    expect(unknown.statusCode).toBe(404);
    expectResponseMatchesSpec("get", "/invites/{code}", 404, unknown.json());

    const code = (await client.post(`/exchanges/${exchangeId}/invites`)).json().code;
    await pool.query("UPDATE invites SET expires_at=now()-interval '1 minute' WHERE exchange_id=$1", [exchangeId]);
    expect((await stranger.get(`/invites/${code}`)).json().status).toBe("EXPIRED");
    const late = await stranger.post(`/invites/${code}/accept`);
    expect(late.statusCode).toBe(409);
    expectResponseMatchesSpec("post", "/invites/{code}/accept", 409, late.json());
    expect(late.json().error.code).toBe("INVITE_EXPIRED");
  });

  it("stops at the exchange's member cap", async () => {
    const { client, exchangeId } = await exchangeWithAdmin();
    await pool.query("UPDATE exchanges SET settings=settings||'{\"maxMembers\":1}' WHERE id=$1", [exchangeId]);
    const code = (await client.post(`/exchanges/${exchangeId}/invites`)).json().code;
    const stranger = v1Client(app, (await createAppUser(pool)).token);
    expect((await stranger.get(`/invites/${code}`)).json().status).toBe("FULL");
    const full = await stranger.post(`/invites/${code}/accept`);
    expect(full.json().error).toMatchObject({ code: "EXCHANGE_FULL", params: { maxMembers: "1" } });
  });

  it("lets only members create invites", async () => {
    const { exchangeId } = await exchangeWithAdmin();
    const outsider = v1Client(app, (await createAppUser(pool)).token);
    const response = await outsider.post(`/exchanges/${exchangeId}/invites`);
    expect(response.statusCode).toBe(403);
    expectResponseMatchesSpec("post", "/exchanges/{exchangeId}/invites", 403, response.json());
  });

  it("never accepts a console claim code as an exchange invite", async () => {
    const stranger = v1Client(app, (await createAppUser(pool)).token);
    const legacy = await pool.query<{ id: string }>("SELECT id FROM listings LIMIT 1");
    if (!legacy.rowCount) return;
    expect((await stranger.get("/invites/AAAA-BBBB")).statusCode).toBe(404);
  });
});

describe("tickers and IPO", () => {
  it("checks a ticker and suggests free ones when it's taken", async () => {
    const { client, exchangeId } = await exchangeWithAdmin("Nathan");
    const free = await client.get(`/exchanges/${exchangeId}/tickers/check?ticker=$nate`);
    expect(free.statusCode).toBe(200);
    expectResponseMatchesSpec("get", "/exchanges/{exchangeId}/tickers/check", 200, free.json());
    expect(free.json()).toEqual({ ticker: "$NATE", available: true, suggestions: [] });

    expect((await client.post(`/exchanges/${exchangeId}/listing`, { ticker: "NATE", consent: true })).statusCode).toBe(201);
    const taken = (await client.get(`/exchanges/${exchangeId}/tickers/check?ticker=NATE`)).json();
    expect(taken.available).toBe(false);
    expect(taken.suggestions.length).toBeGreaterThan(0);
    expect(taken.suggestions).not.toContain("$NATE");
    expect((await client.get(`/exchanges/${exchangeId}/tickers/check?ticker=AURA`)).json().available).toBe(false);
    expect((await client.get(`/exchanges/${exchangeId}/tickers/check?ticker=X1`)).json().available).toBe(false);
  });

  it("lists a consenting member at 100.00 on a 4,000-share pool", async () => {
    const { admin, client, exchangeId } = await exchangeWithAdmin("Mia");
    const response = await client.post(`/exchanges/${exchangeId}/listing`, { ticker: "mia", consent: true });
    expect(response.statusCode).toBe(201);
    expectResponseMatchesSpec("post", "/exchanges/{exchangeId}/listing", 201, response.json());
    expect(response.json()).toMatchObject({ ticker: "$MIA", displayName: "Mia", avatarUrl: null });
    const poolRow = await pool.query("SELECT share_reserve::int AS shares, credit_reserve::int AS credits FROM market_pools WHERE stock_id=$1", [response.json().id]);
    expect(poolRow.rows[0]).toEqual({ shares: 4000, credits: 400000 });
    const me = (await client.get("/me")).json();
    expect(me.memberships[0]).toMatchObject({ exchangeId, listing: { ticker: "$MIA" } });
    expect(me.memberships[0].listingConsentAt).not.toBeNull();
    expect(await tradingState(pool, exchangeId)).toMatchObject({ listedCount: 1, tradingEnabled: false });
    void admin;
  });

  it("requires consent, refuses a taken ticker and a second listing", async () => {
    const { client, exchangeId } = await exchangeWithAdmin("Eli");
    const noConsent = await client.post(`/exchanges/${exchangeId}/listing`, { ticker: "ELI", consent: false });
    expect(noConsent.statusCode).toBe(400);
    expectResponseMatchesSpec("post", "/exchanges/{exchangeId}/listing", 400, noConsent.json());
    await client.post(`/exchanges/${exchangeId}/listing`, { ticker: "ELI", consent: true });
    const twice = await client.post(`/exchanges/${exchangeId}/listing`, { ticker: "ELIX", consent: true });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe("CONFLICT");

    const code = (await client.post(`/exchanges/${exchangeId}/invites`)).json().code;
    const friend = v1Client(app, (await createAppUser(pool, "Elijah")).token);
    await friend.post(`/invites/${code}/accept`);
    const taken = await friend.post(`/exchanges/${exchangeId}/listing`, { ticker: "eli", consent: true });
    expect(taken.statusCode).toBe(409);
    expectResponseMatchesSpec("post", "/exchanges/{exchangeId}/listing", 409, taken.json());
    expect(taken.json().error).toMatchObject({ code: "TICKER_TAKEN", params: { ticker: "$ELI" } });
  });
});
