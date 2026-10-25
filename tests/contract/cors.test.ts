import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { expectResponseMatchesSpec } from "./openapi.js";

// The app's Chrome preview calls /v1 cross-origin (contract request #10); the phone app never needs CORS.
const PREVIEW = "http://localhost:5555";
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false, v1: { corsOrigins: [PREVIEW] } });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const preflight = (origin: string, url = "/v1/auth/email/start") => app.inject({
  method: "OPTIONS", url,
  headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, idempotency-key" }
});

describe("CORS on /v1", () => {
  it("answers an allowed origin's preflight with 204 and what it may send", async () => {
    const response = await preflight(PREVIEW);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers).toMatchObject({
      "access-control-allow-origin": PREVIEW,
      "access-control-allow-methods": "GET, POST, PATCH, DELETE",
      "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key, X-App-Version, X-App-Build",
      "access-control-max-age": "600",
      vary: "Origin"
    });
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("answers preflights on routes that need a token too, since a preflight never carries one", async () => {
    const response = await preflight(PREVIEW, "/v1/me");
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(PREVIEW);
  });

  it("gives any other origin nothing to go on", async () => {
    for (const origin of ["http://localhost:5556", "https://evil.example", "null"]) {
      const response = await preflight(origin);
      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["access-control-allow-methods"]).toBeUndefined();
    }
    const health = await app.inject({ method: "GET", url: "/v1/health", headers: { origin: "https://evil.example" } });
    expect(health.headers["access-control-allow-origin"]).toBeUndefined();
    expect(health.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  it("lets the allowed origin read responses and errors, with the headers it needs exposed", async () => {
    const health = await app.inject({ method: "GET", url: "/v1/health", headers: { origin: PREVIEW } });
    expect(health.statusCode).toBe(200);
    expect(health.headers).toMatchObject({
      "access-control-allow-origin": PREVIEW,
      "cross-origin-resource-policy": "cross-origin",
      vary: "Origin"
    });
    expect(String(health.headers["access-control-expose-headers"])).toContain("Retry-After");

    const signedOut = await app.inject({ method: "GET", url: "/v1/me", headers: { origin: PREVIEW } });
    expect(signedOut.statusCode).toBe(401);
    expectResponseMatchesSpec("get", "/me", 401, signedOut.json());
    expect(signedOut.headers["access-control-allow-origin"]).toBe(PREVIEW);

    const outdated = await app.inject({ method: "GET", url: "/v1/health", headers: { origin: PREVIEW, "x-app-build": "0" } });
    expect(outdated.statusCode).toBe(426);
    expect(outdated.headers["access-control-allow-origin"]).toBe(PREVIEW);
  });

  it("leaves the console's /api alone", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz", headers: { origin: PREVIEW } });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
