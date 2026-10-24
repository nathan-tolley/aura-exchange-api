import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { errorCodes } from "../../src/errors.js";
import { expectResponseMatchesSpec, expectSchema, spec } from "./openapi.js";

let app: FastifyInstance;

async function setHeartbeat(ageSeconds: number): Promise<void> {
  await pool.query(
    `INSERT INTO system_state(key,value,updated_at) VALUES ('worker_heartbeat','{"workerId":"test"}',now() - make_interval(secs => $1))
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at`,
    [ageSeconds]
  );
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("GET /v1/health", () => {
  it("reports OK while the worker heartbeat is fresh", async () => {
    await setHeartbeat(1);
    const response = await app.inject({ method: "GET", url: "/v1/health", headers: { "x-app-version": "1.0.0", "x-app-build": "1" } });
    expect(response.statusCode).toBe(200);
    expectResponseMatchesSpec("get", "/health", 200, response.json());
    expect(response.json()).toMatchObject({ status: "OK", minBuild: 1 });
  });

  it("reports DEGRADED when the worker has gone quiet", async () => {
    await setHeartbeat(300);
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    expectResponseMatchesSpec("get", "/health", 200, response.json());
    expect(response.json().status).toBe("DEGRADED");
    expect(response.json().lastGoodUpdate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("answers an outdated build with a spec-valid 426 UPDATE_REQUIRED", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/health", headers: { "x-app-build": "0" } });
    expect(response.statusCode).toBe(426);
    expectResponseMatchesSpec("get", "/health", 426, response.json());
    expect(response.json().error.code).toBe("UPDATE_REQUIRED");
  });

  it("reports MAINTENANCE without refusing the health check itself", async () => {
    const maintenance = await buildApp({ logger: false, v1: { maintenanceUntil: new Date(Date.now() + 60_000) } });
    try {
      const response = await maintenance.inject({ method: "GET", url: "/v1/health" });
      expect(response.statusCode).toBe(200);
      expectResponseMatchesSpec("get", "/health", 200, response.json());
      expect(response.json().status).toBe("MAINTENANCE");
    } finally {
      await maintenance.close();
    }
  });
});

describe("error contract", () => {
  it("sends spec-valid Error bodies for unknown routes", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/nowhere" });
    expectSchema("Error", response.json());
  });

  it("has a harness that actually rejects bodies that break the spec", () => {
    expect(() => expectResponseMatchesSpec("get", "/health", 200, { status: "FINE", serverTime: "now", minBuild: "1", lastGoodUpdate: null })).toThrow(/does not match/);
    expect(() => expectResponseMatchesSpec("get", "/health", 418, {})).toThrow(/does not declare/);
    expect(() => expectSchema("Error", { error: { code: "X", message: "m", params: { n: 1 }, retryable: false, action: "NONE" } })).toThrow(/does not match/);
  });

  it("knows exactly the error codes the spec lists", () => {
    const specCodes = (spec.components.schemas.ErrorCode as { enum: string[] }).enum;
    expect(Object.keys(errorCodes).sort()).toEqual([...specCodes].sort());
  });
});
