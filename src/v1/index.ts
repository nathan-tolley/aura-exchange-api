import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { appError } from "../errors.js";
import { LogEmailSender, type EmailSender } from "../services/email-sender.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerBearerAuth } from "./bearer.js";
import { registerExchangeRoutes } from "./exchange-routes.js";
import { registerInviteRoutes } from "./invite-routes.js";
import { registerMarketRoutes } from "./market-routes.js";
import { registerIdempotency } from "./idempotency.js";
import { registerMeRoutes } from "./me-routes.js";
import { isoTime } from "./serialize.js";
import { registerSystemRoutes } from "./system-routes.js";

export const V1_PREFIX = "/v1";

export const isV1Request = (url: string) => url === V1_PREFIX || url.startsWith(`${V1_PREFIX}/`) || url.startsWith(`${V1_PREFIX}?`);

export interface V1Options {
  /** App builds below this get 426 UPDATE_REQUIRED. */
  minAppBuild: number;
  /** While in the future, every route but /health answers 503 MAINTENANCE. */
  maintenanceUntil?: Date;
  /** Delivers sign-in codes; defaults to logging them (development). */
  emailSender?: EmailSender;
  /** Sign-in codes one IP may request per hour. */
  loginCodesPerIpPerHour: number;
  /** The clock for market sessions (tests pin it). */
  now: () => Date;
}

export const defaultV1Options = (): V1Options => ({
  minAppBuild: config.MIN_APP_BUILD,
  maintenanceUntil: config.MAINTENANCE_UNTIL,
  loginCodesPerIpPerHour: 20,
  now: () => new Date()
});

/** The /v1 surface for the iPhone app. Its contract is openapi/v1.yaml. */
export async function registerV1(app: FastifyInstance, options: V1Options = defaultV1Options()): Promise<void> {
  await app.register(async (v1) => {
    v1.addHook("onRequest", async (request) => {
      const header = request.headers["x-app-build"];
      if (header === undefined) return;
      const build = Number(Array.isArray(header) ? header[0] : header);
      if (!Number.isInteger(build) || build < 0) throw appError("VALIDATION", { field: "X-App-Build", rule: "integer" }, "X-App-Build must be an integer");
      if (build < options.minAppBuild) {
        throw appError("UPDATE_REQUIRED", { minBuild: String(options.minAppBuild) }, `This app build is too old; ${options.minAppBuild} or newer is required`);
      }
    });

    v1.addHook("onRequest", async (request) => {
      if (!options.maintenanceUntil || options.maintenanceUntil <= new Date()) return;
      if (request.url === `${V1_PREFIX}/health` || request.url.startsWith(`${V1_PREFIX}/health?`)) return;
      throw appError("MAINTENANCE", { until: isoTime(options.maintenanceUntil), reference: request.id }, "The exchange is down for maintenance");
    });

    v1.decorateRequest("v1User", null);
    v1.decorateRequest("membership", null);
    registerBearerAuth(v1);
    // Keys belong to the signed-in user. Public routes (sign-in, refresh) always use the "anon" scope, so a retry
    // replays even if the access token expired between attempts.
    registerIdempotency(v1, { scopeOf: (request) => (request.routeOptions.config?.public ? "anon" : request.v1User?.id ?? "anon") });

    v1.setNotFoundHandler(async (request) => {
      throw appError("NOT_FOUND", { resource: "route" }, `No route for ${request.method} ${request.url}`);
    });

    await registerSystemRoutes(v1, options);
    await registerAuthRoutes(v1, {
      emailSender: options.emailSender ?? new LogEmailSender((fields, message) => v1.log.info(fields, message)),
      loginCodesPerIpPerHour: options.loginCodesPerIpPerHour
    });
    await registerMeRoutes(v1);
    await registerExchangeRoutes(v1);
    await registerInviteRoutes(v1);
    await registerMarketRoutes(v1, { now: options.now });
  }, { prefix: V1_PREFIX });
}
