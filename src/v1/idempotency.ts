import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db.js";
import { appError } from "../errors.js";
import { completeKey, releaseKey, requestHash, reserveKey } from "../services/idempotency-service.js";

declare module "fastify" {
  interface FastifyRequest {
    idempotency: { scope: string; key: string } | null;
  }
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IdempotencyOptions {
  /** Whose keys these are: the signed-in user, or "anon" before sign-in. */
  scopeOf: (request: FastifyRequest) => string;
}

/**
 * Every /v1 write carries an Idempotency-Key (API-CONTRACT.md → Transport). A repeat within 24 h gets the stored
 * response; the same key with a different request gets 409 IDEMPOTENCY_MISMATCH. 5xx responses are not stored,
 * so a retry after a server failure runs again.
 */
export function registerIdempotency(v1: FastifyInstance, options: IdempotencyOptions): void {
  v1.decorateRequest("idempotency", null);

  v1.addHook("preHandler", async (request, reply) => {
    if (!WRITE_METHODS.has(request.method) || request.is404) return;
    const header = request.headers["idempotency-key"];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key) throw appError("VALIDATION", { field: "Idempotency-Key", rule: "required" }, "The Idempotency-Key header is required on writes");
    if (!UUID.test(key)) throw appError("VALIDATION", { field: "Idempotency-Key", rule: "uuid" }, "Idempotency-Key must be a UUID");

    const scope = options.scopeOf(request);
    const hash = requestHash(request.method, request.url, request.body);
    const existing = await reserveKey(pool, scope, key.toLowerCase(), request.method, request.url, hash);
    if (!existing) {
      request.idempotency = { scope, key: key.toLowerCase() };
      return;
    }
    if (existing.request_hash !== hash) {
      throw appError("IDEMPOTENCY_MISMATCH", {}, "This Idempotency-Key was already used for a different request");
    }
    if (existing.status_code === null) {
      throw appError("IDEMPOTENCY_IN_PROGRESS", {}, "The first request with this Idempotency-Key is still running");
    }
    reply.header("idempotent-replayed", "true").code(existing.status_code);
    if (existing.response_body === null) return reply.send();
    return reply.type("application/json; charset=utf-8").send(existing.response_body);
  });

  v1.addHook("onSend", async (request, reply, payload) => {
    const pending = request.idempotency;
    if (!pending) return payload;
    request.idempotency = null;
    try {
      if (reply.statusCode >= 500) {
        await releaseKey(pool, pending.scope, pending.key);
      } else {
        const body = typeof payload === "string" ? payload : Buffer.isBuffer(payload) ? payload.toString("utf8") : null;
        await completeKey(pool, pending.scope, pending.key, reply.statusCode, body === "" ? null : body);
      }
    } catch (error) {
      request.log.error({ err: error, idempotencyKey: pending.key }, "idempotency.store_failed");
    }
    return payload;
  });
}
