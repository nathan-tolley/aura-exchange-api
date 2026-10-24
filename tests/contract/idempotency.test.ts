import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db.js";
import { errorHandler } from "../../src/error-handler.js";
import { appError } from "../../src/errors.js";
import { canonicalJson, purgeExpiredKeys, requestHash } from "../../src/services/idempotency-service.js";
import { registerIdempotency } from "../../src/v1/idempotency.js";
import { expectResponseMatchesSpec, expectSchema } from "./openapi.js";

let app: FastifyInstance;
let calls = 0;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(async (v1) => {
    registerIdempotency(v1, { scopeOf: (request) => String(request.headers["x-test-user"] ?? "anon") });
    v1.post("/things", async (request, reply) => {
      calls += 1;
      reply.code(201);
      return { call: calls, echo: request.body };
    });
    v1.post("/reject", async () => {
      calls += 1;
      throw appError("INSUFFICIENT_CASH", { needed: "10.00", available: "5.00", shortBy: "5.00", maxQuantity: "0" });
    });
    v1.post("/explode", async () => {
      calls += 1;
      throw new Error("boom");
    });
    v1.delete("/things/:id", async (_request, reply) => {
      calls += 1;
      return reply.code(204).send();
    });
  }, { prefix: "/v1" });
});

beforeEach(() => {
  calls = 0;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const post = (url: string, key: string | undefined, payload: unknown, user?: string) => app.inject({
  method: "POST",
  url,
  payload: payload as Record<string, unknown>,
  headers: { ...(key ? { "idempotency-key": key } : {}), ...(user ? { "x-test-user": user } : {}) }
});

describe("Idempotency-Key on /v1 writes", () => {
  it("is required", async () => {
    const response = await post("/v1/things", undefined, { a: 1 });
    expect(response.statusCode).toBe(400);
    expectResponseMatchesSpec("post", "/trades", 400, response.json());
    expect(response.json().error).toMatchObject({ code: "VALIDATION", params: { field: "Idempotency-Key", rule: "required" } });
    expect(calls).toBe(0);
  });

  it("must be a UUID", async () => {
    const response = await post("/v1/things", "not-a-uuid", { a: 1 });
    expect(response.json().error.params).toEqual({ field: "Idempotency-Key", rule: "uuid" });
  });

  it("replays the stored response for a repeated key without running the handler again", async () => {
    const key = randomUUID();
    const first = await post("/v1/things", key, { quantity: "20", side: "BUY" });
    const second = await post("/v1/things", key, { side: "BUY", quantity: "20" });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(calls).toBe(1);
  });

  it("answers the same key with a different body with a spec-valid 409 IDEMPOTENCY_MISMATCH", async () => {
    const key = randomUUID();
    await post("/v1/things", key, { quantity: "20" });
    const response = await post("/v1/things", key, { quantity: "21" });
    expect(response.statusCode).toBe(409);
    expectResponseMatchesSpec("post", "/trades", 409, response.json());
    expect(response.json().error).toMatchObject({ code: "IDEMPOTENCY_MISMATCH", retryable: false, action: "NONE" });
    expect(calls).toBe(1);
  });

  it("treats the same key on another route as a mismatch", async () => {
    const key = randomUUID();
    await post("/v1/things", key, {});
    const response = await post("/v1/reject", key, {});
    expect(response.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("keeps each user's keys apart", async () => {
    const key = randomUUID();
    await post("/v1/things", key, { a: 1 }, "user-a");
    const other = await post("/v1/things", key, { a: 1 }, "user-b");
    expect(other.headers["idempotent-replayed"]).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("stores and replays rejections (4xx)", async () => {
    const key = randomUUID();
    const first = await post("/v1/reject", key, {});
    const second = await post("/v1/reject", key, {});
    expect(first.statusCode).toBe(422);
    expect(second.statusCode).toBe(422);
    expect(second.json()).toEqual(first.json());
    expectSchema("Error", second.json());
    expect(calls).toBe(1);
  });

  it("does not store server failures, so a retry runs again", async () => {
    const key = randomUUID();
    const first = await post("/v1/explode", key, {});
    const second = await post("/v1/explode", key, {});
    expect(first.statusCode).toBe(500);
    expect(second.statusCode).toBe(500);
    expect(second.json().error.code).toBe("SERVER");
    expect(calls).toBe(2);
  });

  it("answers a key whose first request is still running with 409 IDEMPOTENCY_IN_PROGRESS", async () => {
    const key = randomUUID();
    await pool.query(
      "INSERT INTO idempotency_keys(scope,idempotency_key,method,path,request_hash) VALUES ('anon',$1,'POST','/v1/things',$2)",
      [key, requestHash("POST", "/v1/things", {})]
    );
    const running = await post("/v1/things", key, {});
    expect(running.statusCode).toBe(409);
    expectResponseMatchesSpec("post", "/trades", 409, running.json());
    expect(running.json().error).toMatchObject({ code: "IDEMPOTENCY_IN_PROGRESS", retryable: true, action: "RETRY" });
    expect(calls).toBe(0);
  });

  it("reports a different body as a mismatch even while the first request runs", async () => {
    const key = randomUUID();
    await pool.query(
      "INSERT INTO idempotency_keys(scope,idempotency_key,method,path,request_hash) VALUES ('anon',$1,'POST','/v1/things','other')",
      [key]
    );
    const response = await post("/v1/things", key, {});
    expect(response.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("releases a key whose first request died long ago", async () => {
    const key = randomUUID();
    await pool.query(
      `INSERT INTO idempotency_keys(scope,idempotency_key,method,path,request_hash,created_at)
       VALUES ('anon',$1,'POST','/v1/things',$2,now()-interval '10 minutes')`,
      [key, requestHash("POST", "/v1/things", {})]
    );
    const response = await post("/v1/things", key, {});
    expect(response.statusCode).toBe(201);
    expect(calls).toBe(1);
  });

  it("replays bodiless 204 responses", async () => {
    const key = randomUUID();
    const first = await app.inject({ method: "DELETE", url: "/v1/things/1", headers: { "idempotency-key": key } });
    const second = await app.inject({ method: "DELETE", url: "/v1/things/1", headers: { "idempotency-key": key } });
    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
    expect(second.body).toBe("");
    expect(calls).toBe(1);
  });

  it("forgets keys after 24 hours", async () => {
    const key = randomUUID();
    await post("/v1/things", key, {});
    await pool.query("UPDATE idempotency_keys SET expires_at=now()-interval '1 second' WHERE idempotency_key=$1", [key]);
    expect(await purgeExpiredKeys(pool)).toBeGreaterThanOrEqual(1);
    const again = await post("/v1/things", key, {});
    expect(again.headers["idempotent-replayed"]).toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe("canonicalJson", () => {
  it("ignores key order and undefined fields", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }], skip: undefined })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
  });
});
