import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { appError } from "../errors.js";
import { isoTime } from "./serialize.js";
import { registerSystemRoutes } from "./system-routes.js";

export const V1_PREFIX = "/v1";

export const isV1Request = (url: string) => url === V1_PREFIX || url.startsWith(`${V1_PREFIX}/`) || url.startsWith(`${V1_PREFIX}?`);

export interface V1Options {
  /** App builds below this get 426 UPDATE_REQUIRED. */
  minAppBuild: number;
  /** While in the future, every route but /health answers 503 MAINTENANCE. */
  maintenanceUntil?: Date;
}

export const defaultV1Options = (): V1Options => ({
  minAppBuild: config.MIN_APP_BUILD,
  maintenanceUntil: config.MAINTENANCE_UNTIL
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

    v1.setNotFoundHandler(async (request) => {
      throw appError("NOT_FOUND", { resource: "route" }, `No route for ${request.method} ${request.url}`);
    });

    await registerSystemRoutes(v1, options);
  }, { prefix: V1_PREFIX });
}
