import type { FastifyInstance, FastifyReply } from "fastify";

// What a browser client of /v1 (the app's Chrome preview) may send and read. The phone app makes native requests,
// which CORS never applies to.
const ALLOW_METHODS = "GET, POST, PATCH, DELETE";
const ALLOW_HEADERS = "Authorization, Content-Type, Idempotency-Key, X-App-Version, X-App-Build";
const EXPOSE_HEADERS = "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Idempotent-Replayed";
const PREFLIGHT_MAX_AGE_SECONDS = "600";

function varyOnOrigin(reply: FastifyReply): void {
  const vary = reply.getHeader("vary");
  if (!vary) reply.header("Vary", "Origin");
  else if (!String(vary).split(",").some((name) => name.trim().toLowerCase() === "origin")) reply.header("Vary", `${vary}, Origin`);
}

/**
 * CORS on /v1 for an allow-list of exact origins (`CORS_ORIGINS`), never `*`. No credentials: /v1 authenticates with
 * bearer tokens, not cookies. A preflight is answered with 204 before any other /v1 hook (it carries no token or app
 * build); every other response, errors included, carries the headers so the browser lets the app read the error shape.
 */
export function registerCors(v1: FastifyInstance, origins: readonly string[]): void {
  const allowed = new Set(origins);
  const allowedOrigin = (origin: string | undefined) => (origin !== undefined && allowed.has(origin) ? origin : null);

  v1.addHook("onRequest", async (request, reply) => {
    if (request.method !== "OPTIONS" || request.headers["access-control-request-method"] === undefined) return;
    if (allowedOrigin(request.headers.origin)) {
      reply.headers({
        "Access-Control-Allow-Methods": ALLOW_METHODS,
        "Access-Control-Allow-Headers": ALLOW_HEADERS,
        "Access-Control-Max-Age": PREFLIGHT_MAX_AGE_SECONDS
      });
    }
    // A preflight from any other origin gets no Allow-Origin, so the browser refuses the real request.
    return reply.code(204).send();
  });

  v1.addHook("onSend", async (request, reply, payload) => {
    varyOnOrigin(reply);
    const origin = allowedOrigin(request.headers.origin);
    if (origin) {
      reply.headers({
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Expose-Headers": EXPOSE_HEADERS,
        "Cross-Origin-Resource-Policy": "cross-origin"
      });
    }
    return payload;
  });
}
