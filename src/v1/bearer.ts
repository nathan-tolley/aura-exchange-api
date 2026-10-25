import type { FastifyInstance } from "fastify";
import { appError } from "../errors.js";
import { verifyAccessToken } from "../services/token-service.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** A /v1 route anyone may call without a bearer token (the spec's `security: []`). */
    public?: boolean;
  }
}

/**
 * `Authorization: Bearer <accessToken>` on every /v1 route that isn't public. A missing, invalid or expired token is
 * 401 AUTH_EXPIRED (the app refreshes, then signs in). On public routes a bad token is ignored, so an app that sends
 * a stale token everywhere can still refresh.
 */
export function registerBearerAuth(v1: FastifyInstance): void {
  v1.addHook("onRequest", async (request) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
    const userId = token ? await verifyAccessToken(token) : null;
    if (userId) request.v1User = { id: userId };
    if (request.is404 || request.routeOptions.config?.public) return;
    if (!userId) throw appError("AUTH_EXPIRED", {}, token ? "The access token is invalid or expired" : "Sign in required");
  });
}
