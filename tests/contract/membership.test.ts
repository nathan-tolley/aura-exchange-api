import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db.js";
import { errorHandler } from "../../src/error-handler.js";
import { membershipGuard, requireScopedResource } from "../../src/v1/membership.js";
import { addListedMember, createExchange } from "../support/fixtures.js";
import { expectResponseMatchesSpec } from "./openapi.js";

let app: FastifyInstance;
let a: { exchangeId: string; seasonId: string };
let b: { exchangeId: string; seasonId: string };
let memberOfA: string;
let listingInA: string;
let listingInB: string;

beforeAll(async () => {
  a = await createExchange(pool);
  b = await createExchange(pool);
  ({ userId: memberOfA, listingId: listingInA } = await addListedMember(pool, a.exchangeId, a.seasonId, "MEMA"));
  ({ listingId: listingInB } = await addListedMember(pool, b.exchangeId, b.seasonId, "MEMB"));

  app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(async (v1) => {
    v1.decorateRequest("v1User", null);
    v1.decorateRequest("membership", null);
    // Stands in for the bearer guard (0.4).
    v1.addHook("onRequest", async (request) => {
      const id = request.headers["x-test-user"];
      if (typeof id === "string") request.v1User = { id };
    });
    v1.get("/exchanges/:exchangeId/market", { preHandler: membershipGuard() }, async (request) => ({ exchangeId: request.membership!.exchangeId }));
    v1.get("/exchanges/:exchangeId/settings", { preHandler: membershipGuard({ roles: ["ADMIN"] }) }, async () => ({ ok: true }));
    v1.get("/listings/:listingId", async (request) => {
      const membership = await requireScopedResource(pool, request, "listings", (request.params as { listingId: string }).listingId);
      return { exchangeId: membership.exchangeId };
    });
  }, { prefix: "/v1" });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const get = (url: string, user?: string) => app.inject({ method: "GET", url, headers: user ? { "x-test-user": user } : {} });

describe("membership guard", () => {
  it("requires a signed-in user", async () => {
    const response = await get(`/v1/exchanges/${a.exchangeId}/market`);
    expect(response.statusCode).toBe(401);
    expectResponseMatchesSpec("get", "/exchanges/{exchangeId}/market", 401, response.json());
    expect(response.json().error.code).toBe("AUTH_EXPIRED");
  });

  it("lets members into their own exchange", async () => {
    const response = await get(`/v1/exchanges/${a.exchangeId}/market`, memberOfA);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ exchangeId: a.exchangeId });
  });

  it("answers other exchanges with a spec-valid 403 NOT_A_MEMBER", async () => {
    const response = await get(`/v1/exchanges/${b.exchangeId}/market`, memberOfA);
    expect(response.statusCode).toBe(403);
    expectResponseMatchesSpec("get", "/exchanges/{exchangeId}/market", 403, response.json());
    expect(response.json().error).toMatchObject({ code: "NOT_A_MEMBER", params: { exchangeId: b.exchangeId } });
  });

  it("treats unknown and malformed exchange ids the same way", async () => {
    expect((await get(`/v1/exchanges/${randomUUID()}/market`, memberOfA)).json().error.code).toBe("NOT_A_MEMBER");
    expect((await get("/v1/exchanges/not-an-id/market", memberOfA)).json().error.code).toBe("NOT_A_MEMBER");
  });

  it("enforces exchange roles", async () => {
    const asMember = await get(`/v1/exchanges/${a.exchangeId}/settings`, memberOfA);
    expect(asMember.statusCode).toBe(403);
    expect(asMember.json().error.code).toBe("FORBIDDEN");
    await pool.query("UPDATE memberships SET role='ADMIN' WHERE user_id=$1 AND exchange_id=$2", [memberOfA, a.exchangeId]);
    expect((await get(`/v1/exchanges/${a.exchangeId}/settings`, memberOfA)).statusCode).toBe(200);
  });
});

describe("resources addressed by id", () => {
  it("are reachable through the exchange they belong to", async () => {
    const response = await get(`/v1/listings/${listingInA}`, memberOfA);
    expect(response.json()).toEqual({ exchangeId: a.exchangeId });
  });

  it("answer another exchange's resource exactly like a missing one", async () => {
    const foreign = await get(`/v1/listings/${listingInB}`, memberOfA);
    const missing = await get(`/v1/listings/${randomUUID()}`, memberOfA);
    expect(foreign.statusCode).toBe(404);
    expectResponseMatchesSpec("get", "/listings/{listingId}", 404, foreign.json());
    expect(foreign.json()).toEqual(missing.json());
    expect(foreign.json().error).toMatchObject({ code: "NOT_FOUND", params: { resource: "listing" } });
  });
});
