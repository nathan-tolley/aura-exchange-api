import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("/v1 surface", () => {
  it("answers unknown /v1 routes with the contract error shape", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "No route for GET /v1/does-not-exist", params: { resource: "route" }, retryable: false, action: "NONE" }
    });
  });

  it("answers malformed /v1 bodies with VALIDATION", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/does-not-exist", headers: { "content-type": "application/json" }, payload: "{" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "VALIDATION", params: { field: "body" } });
  });
});

describe("/v1 app version gate", () => {
  it("lets requests without X-App-Build through", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(response.statusCode).toBe(404);
  });

  it("answers builds below MIN_APP_BUILD with 426 UPDATE_REQUIRED", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/does-not-exist", headers: { "x-app-version": "0.9.0", "x-app-build": "0" } });
    expect(response.statusCode).toBe(426);
    expect(response.json().error).toMatchObject({ code: "UPDATE_REQUIRED", params: { minBuild: "1" }, action: "UPDATE_APP", retryable: false });
  });

  it("rejects a malformed build number", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/does-not-exist", headers: { "x-app-build": "thirty-seven" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "VALIDATION", params: { field: "X-App-Build", rule: "integer" } });
  });
});

describe("/v1 maintenance", () => {
  it("answers 503 MAINTENANCE with the end time while it lasts", async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000);
    const maintenance = await buildApp({ logger: false, v1: { maintenanceUntil: until } });
    try {
      const response = await maintenance.inject({ method: "GET", url: "/v1/does-not-exist" });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatchObject({ code: "MAINTENANCE", retryable: true, action: "RETRY", params: { until: until.toISOString().replace(/\.\d{3}Z$/, "Z") } });
      expect(typeof response.json().error.params.reference).toBe("string");
    } finally {
      await maintenance.close();
    }
  });
});

describe("legacy /api errors", () => {
  it("keep their { error, message } shape", async () => {
    const response = await app.inject({ method: "GET", url: "/api/auth/session" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "UNAUTHORIZED", message: "Sign in required" });
  });

  it("return 400 for invalid input instead of a 500", async () => {
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR", message: "Invalid request" });
  });

  it("pass Fastify's own client errors through", async () => {
    const response = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: "{" });
    expect(response.statusCode).toBe(400);
    expect(typeof response.json().message).toBe("string");
  });
});
