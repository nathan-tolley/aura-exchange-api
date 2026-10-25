import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { accountBalance, accounts } from "../../src/core/ledger.js";
import { pool } from "../../src/db.js";
import { activeSeason } from "../../src/services/exchange-service.js";
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

describe("exchanges", () => {
  it("creates one with its creator as admin, season 1 and the creator's starting cash", async () => {
    const { userId, token } = await createAppUser(pool, "Nathan");
    const response = await v1Client(app, token).post("/exchanges", { name: "The Group Chat", timezone: "America/New_York" });
    expect(response.statusCode).toBe(201);
    expectResponseMatchesSpec("post", "/exchanges", 201, response.json());
    const exchange = response.json();
    expect(exchange).toMatchObject({
      name: "The Group Chat", timezone: "America/New_York",
      hours: { preOpen: "07:00", open: "09:00", close: "22:00", afterClose: "02:00" },
      feeRate: "0.50", extendedFeeRate: "1.50", listedCount: 0, memberCount: 1, minListingsToOpen: 3,
      season: { number: 1 }, me: { role: "ADMIN", listing: null }
    });
    const season = await activeSeason(pool, exchange.id);
    expect((await accountBalance(pool as never, accounts.userCash(userId, season!.id))).toFixed(2)).toBe("10000.00");
  });

  it("takes custom hours", async () => {
    const { token } = await createAppUser(pool);
    const hours = { preOpen: "06:00", open: "08:00", close: "20:00", afterClose: "23:30" };
    const response = await v1Client(app, token).post("/exchanges", { name: "Night Owls", timezone: "Europe/London", hours });
    expect(response.json().hours).toEqual(hours);
  });

  it("rejects unknown timezones and impossible hours with spec-valid VALIDATION errors", async () => {
    const client = v1Client(app, (await createAppUser(pool)).token);
    const timezone = await client.post("/exchanges", { name: "Nowhere", timezone: "Mars/Olympus_Mons" });
    expect(timezone.statusCode).toBe(400);
    expectResponseMatchesSpec("post", "/exchanges", 400, timezone.json());
    expect(timezone.json().error.params.field).toBe("timezone");
    const hours = await client.post("/exchanges", { name: "Backwards", timezone: "UTC", hours: { preOpen: "09:00", open: "07:00", close: "22:00", afterClose: "02:00" } });
    expect(hours.json().error.params.field).toBe("hours");
  });

  it("lists only the caller's exchanges", async () => {
    const mine = v1Client(app, (await createAppUser(pool)).token);
    const other = v1Client(app, (await createAppUser(pool)).token);
    const created = (await mine.post("/exchanges", { name: "Mine Only", timezone: "UTC" })).json();
    await other.post("/exchanges", { name: "Not Mine", timezone: "UTC" });
    const list = await mine.get("/exchanges");
    expect(list.statusCode).toBe(200);
    expectResponseMatchesSpec("get", "/exchanges", 200, list.json());
    expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([created.id]);
  });

  it("shows an exchange to members only", async () => {
    const owner = v1Client(app, (await createAppUser(pool)).token);
    const outsider = v1Client(app, (await createAppUser(pool)).token);
    const created = (await owner.post("/exchanges", { name: "Members Only", timezone: "UTC" })).json();
    const mine = await owner.get(`/exchanges/${created.id}`);
    expect(mine.statusCode).toBe(200);
    expectResponseMatchesSpec("get", "/exchanges/{exchangeId}", 200, mine.json());
    const theirs = await outsider.get(`/exchanges/${created.id}`);
    expect(theirs.statusCode).toBe(403);
    expectResponseMatchesSpec("get", "/exchanges/{exchangeId}", 403, theirs.json());
  });
});
