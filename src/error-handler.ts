import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError, errorBody, toContractError } from "./errors.js";
import { isV1Request } from "./v1/index.js";

/** The one error handler: /v1 gets the contract shape, /api keeps its legacy { error, message, details } body. */
export function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
  if (isV1Request(request.url)) {
    const contractError = toContractError(error, { reference: request.id, retryAfter: reply.getHeader("retry-after") });
    if (contractError.code === "SERVER") request.log.error({ err: error, reference: request.id }, "v1.server_error");
    return reply.code(contractError.statusCode).send(errorBody(contractError));
  }
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "VALIDATION_ERROR", message: "Invalid request", details: error.issues });
  }
  if (error instanceof AppError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message, details: error.details });
  }
  if ((error as { code?: string }).code === "23505") {
    return reply.code(409).send({ error: "CONFLICT", message: "That value already exists" });
  }
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const code = (error as { code?: unknown }).code;
    return reply.code(status).send({ error: typeof code === "string" ? code : status === 429 ? "RATE_LIMITED" : "BAD_REQUEST", message: (error as Error).message });
  }
  request.log.error(error);
  return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Something went sideways in the market" });
}
