import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import type { EmailSender } from "../../src/services/email-sender.js";
import { signAccessToken } from "../../src/services/token-service.js";
import { createExchange } from "../support/fixtures.js";
import { expectResponseMatchesSpec } from "./openapi.js";

class CapturingSender implements EmailSender {
  readonly codes = new Map<string, string>();
  async sendLoginCode(email: string, code: string): Promise<void> {
    this.codes.set(email, code);
  }
}

const sender = new CapturingSender();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false, v1: { emailSender: sender, loginCodesPerIpPerHour: 1000 } });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const newEmail = () => `trader-${randomUUID().slice(0, 8)}@example.com`;

function post(url: string, payload: Record<string, unknown>, options: { token?: string; key?: string; origin?: string } = {}) {
  return app.inject({
    method: "POST",
    url,
    payload,
    headers: {
      "idempotency-key": options.key ?? randomUUID(),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.origin ? { origin: options.origin } : {})
    }
  });
}

const get = (url: string, token?: string) => app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });

async function signIn(email = newEmail()) {
  expect((await post("/v1/auth/email/start", { email })).statusCode).toBe(204);
  const response = await post("/v1/auth/email/verify", { email, code: sender.codes.get(email.toLowerCase())! });
  expect(response.statusCode).toBe(200);
  return response.json() as { accessToken: string; refreshToken: string; expiresIn: number; user: { id: string; email: string } };
}

describe("POST /v1/auth/email/start", () => {
  it("emails a 6-digit code and answers 204", async () => {
    const email = newEmail();
    const response = await post("/v1/auth/email/start", { email });
    expect(response.statusCode).toBe(204);
    expectResponseMatchesSpec("post", "/auth/email/start", 204, response.body);
    expect(sender.codes.get(email)).toMatch(/^\d{6}$/);
  });

  it("rejects a malformed email with a spec-valid VALIDATION", async () => {
    const response = await post("/v1/auth/email/start", { email: "not-an-email" });
    expect(response.statusCode).toBe(400);
    expectResponseMatchesSpec("post", "/auth/email/start", 400, response.json());
    expect(response.json().error.params).toMatchObject({ field: "email" });
  });

  it("limits each email to 5 codes an hour", async () => {
    const email = newEmail();
    for (let i = 0; i < 5; i += 1) expect((await post("/v1/auth/email/start", { email })).statusCode).toBe(204);
    const sixth = await post("/v1/auth/email/start", { email });
    expect(sixth.statusCode).toBe(429);
    expectResponseMatchesSpec("post", "/auth/email/start", 429, sixth.json());
    expect(Number(sixth.json().error.params.retryAfterSeconds)).toBeGreaterThan(0);
  });

  it("limits how many codes one IP can request", async () => {
    const strict = await buildApp({ logger: false, v1: { emailSender: sender, loginCodesPerIpPerHour: 2 } });
    try {
      const start = () => strict.inject({ method: "POST", url: "/v1/auth/email/start", payload: { email: newEmail() }, headers: { "idempotency-key": randomUUID() } });
      expect((await start()).statusCode).toBe(204);
      expect((await start()).statusCode).toBe(204);
      const third = await start();
      expect(third.statusCode).toBe(429);
      expectResponseMatchesSpec("post", "/auth/email/start", 429, third.json());
      expect(third.json().error).toMatchObject({ code: "RATE_LIMITED", retryable: true, action: "WAIT" });
    } finally {
      await strict.close();
    }
  });

  it("is not blocked by the console's origin check", async () => {
    const response = await post("/v1/auth/email/start", { email: newEmail() }, { origin: "https://somewhere-else.example" });
    expect(response.statusCode).toBe(204);
  });
});

describe("POST /v1/auth/email/verify", () => {
  it("signs in with the code, creating the account the first time", async () => {
    const email = newEmail();
    await post("/v1/auth/email/start", { email: email.toUpperCase() });
    const response = await post("/v1/auth/email/verify", { email, code: sender.codes.get(email)! });
    expect(response.statusCode).toBe(200);
    expectResponseMatchesSpec("post", "/auth/email/verify", 200, response.json());
    expect(response.json()).toMatchObject({ expiresIn: 900, user: { email } });
    const again = await signIn(email);
    expect(again.user.id).toBe(response.json().user.id);
  });

  it("counts wrong codes and then gives up on the code", async () => {
    const email = newEmail();
    await post("/v1/auth/email/start", { email });
    const right = sender.codes.get(email)!;
    const wrong = right === "000000" ? "111111" : "000000";
    const first = await post("/v1/auth/email/verify", { email, code: wrong });
    expect(first.statusCode).toBe(401);
    expectResponseMatchesSpec("post", "/auth/email/verify", 401, first.json());
    expect(first.json().error).toMatchObject({ code: "LOGIN_CODE_INVALID", params: { attemptsLeft: "4" } });
    for (let i = 0; i < 4; i += 1) await post("/v1/auth/email/verify", { email, code: wrong });
    const afterFive = await post("/v1/auth/email/verify", { email, code: right });
    expect(afterFive.statusCode).toBe(401);
    expectResponseMatchesSpec("post", "/auth/email/verify", 401, afterFive.json());
    expect(afterFive.json().error.code).toBe("LOGIN_CODE_EXPIRED");
  });

  it("refuses an expired code", async () => {
    const email = newEmail();
    await post("/v1/auth/email/start", { email });
    await pool.query("UPDATE login_codes SET expires_at=now()-interval '1 second' WHERE email=$1", [email]);
    const response = await post("/v1/auth/email/verify", { email, code: sender.codes.get(email)! });
    expect(response.json().error.code).toBe("LOGIN_CODE_EXPIRED");
  });

  it("only accepts the newest code", async () => {
    const email = newEmail();
    await post("/v1/auth/email/start", { email });
    const old = sender.codes.get(email)!;
    await post("/v1/auth/email/start", { email });
    const newest = sender.codes.get(email)!;
    if (old !== newest) expect((await post("/v1/auth/email/verify", { email, code: old })).statusCode).toBe(401);
    expect((await post("/v1/auth/email/verify", { email, code: newest })).statusCode).toBe(200);
  });

  it("stores only a hash of the code", async () => {
    const email = newEmail();
    await post("/v1/auth/email/start", { email });
    const row = await pool.query("SELECT code_hash FROM login_codes WHERE email=$1", [email]);
    expect(row.rows[0].code_hash).not.toContain(sender.codes.get(email));
    expect(row.rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("refresh tokens", () => {
  it("rotate: each refresh returns a new pair", async () => {
    const session = await signIn();
    const response = await post("/v1/auth/refresh", { refreshToken: session.refreshToken });
    expect(response.statusCode).toBe(200);
    expectResponseMatchesSpec("post", "/auth/refresh", 200, response.json());
    expect(response.json().refreshToken).not.toBe(session.refreshToken);
    expect(response.json().user.id).toBe(session.user.id);
  });

  it("revoke the whole family when an old token is reused", async () => {
    const session = await signIn();
    const rotated = (await post("/v1/auth/refresh", { refreshToken: session.refreshToken })).json();
    const reuse = await post("/v1/auth/refresh", { refreshToken: session.refreshToken });
    expect(reuse.statusCode).toBe(401);
    expectResponseMatchesSpec("post", "/auth/refresh", 401, reuse.json());
    expect(reuse.json().error).toMatchObject({ code: "AUTH_EXPIRED", action: "SIGN_IN" });
    // The legitimate holder of the newest token is signed out too: someone else had a copy.
    expect((await post("/v1/auth/refresh", { refreshToken: rotated.refreshToken })).statusCode).toBe(401);
    const family = await pool.query("SELECT COUNT(*)::int AS live FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL", [session.user.id]);
    expect(family.rows[0].live).toBe(0);
  });

  it("let a retried refresh with the same Idempotency-Key replay instead of tripping reuse detection", async () => {
    const session = await signIn();
    const key = randomUUID();
    const first = await post("/v1/auth/refresh", { refreshToken: session.refreshToken }, { key });
    const retry = await post("/v1/auth/refresh", { refreshToken: session.refreshToken }, { key });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().refreshToken).toBe(first.json().refreshToken);
    expect((await post("/v1/auth/refresh", { refreshToken: first.json().refreshToken })).statusCode).toBe(200);
  });

  it("still work when the app sends a stale access token along", async () => {
    const session = await signIn();
    const response = await post("/v1/auth/refresh", { refreshToken: session.refreshToken }, { token: "not-a-real-token" });
    expect(response.statusCode).toBe(200);
  });

  it("stop working after logout", async () => {
    const session = await signIn();
    const logout = await post("/v1/auth/logout", { refreshToken: session.refreshToken }, { token: session.accessToken });
    expect(logout.statusCode).toBe(204);
    expectResponseMatchesSpec("post", "/auth/logout", 204, logout.body);
    expect((await post("/v1/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(401);
  });

  it("need a signed-in user to log out", async () => {
    const response = await post("/v1/auth/logout", { refreshToken: "rt_whatever-token" });
    expect(response.statusCode).toBe(401);
    expectResponseMatchesSpec("post", "/auth/logout", 401, response.json());
  });
});

describe("GET /v1/me", () => {
  it("needs a valid, unexpired access token", async () => {
    for (const token of [undefined, "garbage", await signAccessToken(randomUUID(), new Date(Date.now() - 60 * 60 * 1000))]) {
      const response = await get("/v1/me", token);
      expect(response.statusCode).toBe(401);
      expectResponseMatchesSpec("get", "/me", 401, response.json());
      expect(response.json().error.code).toBe("AUTH_EXPIRED");
    }
  });

  it("returns the user and their memberships", async () => {
    const session = await signIn();
    const empty = await get("/v1/me", session.accessToken);
    expect(empty.statusCode).toBe(200);
    expectResponseMatchesSpec("get", "/me", 200, empty.json());
    expect(empty.json()).toMatchObject({ user: { id: session.user.id, email: session.user.email }, memberships: [] });

    const { exchangeId } = await createExchange(pool);
    await pool.query("INSERT INTO memberships(exchange_id,user_id,role,listing_consent_at) VALUES ($1,$2,'ADMIN',now())", [exchangeId, session.user.id]);
    const listing = await pool.query<{ id: string }>(
      "INSERT INTO listings(exchange_id,display_name,ticker,owner_user_id,is_active,claimed_at,consented_at) VALUES ($1,'Nate','nate',$2,true,now(),now()) RETURNING id",
      [exchangeId, session.user.id]
    );
    const me = await get("/v1/me", session.accessToken);
    expectResponseMatchesSpec("get", "/me", 200, me.json());
    expect(me.json().memberships).toEqual([expect.objectContaining({
      exchangeId, role: "ADMIN", listing: { id: listing.rows[0]!.id, ticker: "$NATE", displayName: "Nate", avatarUrl: null }, superInjunctionsLeft: 3
    })]);
  });
});
