import type { FastifyInstance } from "fastify";
import { appError } from "../errors.js";

export const V1_PREFIX = "/v1";

export const isV1Request = (url: string) => url === V1_PREFIX || url.startsWith(`${V1_PREFIX}/`) || url.startsWith(`${V1_PREFIX}?`);

/** The /v1 surface for the iPhone app. Its contract is openapi/v1.yaml. */
export async function registerV1(app: FastifyInstance): Promise<void> {
  await app.register(async (v1) => {
    v1.setNotFoundHandler(async (request) => {
      throw appError("NOT_FOUND", { resource: "route" }, `No route for ${request.method} ${request.url}`);
    });
  }, { prefix: V1_PREFIX });
}
