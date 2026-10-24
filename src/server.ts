import path from "node:path";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import { config, isProduction } from "./config.js";
import { loadSession } from "./auth.js";
import { AppError } from "./errors.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerAuraRoutes } from "./routes/aura-routes.js";
import { registerTradeRoutes } from "./routes/trade-routes.js";
import { registerReadRoutes } from "./routes/read-routes.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerProfileRoutes } from "./routes/profile-routes.js";
import { registerVoteRoutes } from "./routes/vote-routes.js";
import { registerChatGPTRoutes } from "./routes/chatgpt-routes.js";
import { registerAuraFarmingRoutes } from "./routes/aura-farming-routes.js";
import {registerDerivativesRoutes} from "./routes/derivatives-routes.js";
import { assertMigrationsCurrent } from "./services/migration-service.js";
import { pool } from "./db.js";
import { forbidden, unauthorized } from "./errors.js";

const app = Fastify({ logger: { level: isProduction ? "info" : "debug" }, trustProxy: true });

await assertMigrationsCurrent(pool);

await app.register(cookie, { secret: config.SESSION_SECRET });
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: new URL(config.APP_ORIGIN).protocol === "https:" ? [] : null
    }
  },
  referrerPolicy: { policy: "no-referrer" }
});
await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

app.decorateRequest("auth", null);
app.addHook("preHandler", loadSession);
app.addHook("preHandler", async (request) => {
  if (request.url.startsWith("/uploads/") && !request.auth) throw unauthorized();
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin && origin !== new URL(config.APP_ORIGIN).origin) throw forbidden("Request origin is not allowed");
  }
});
app.addHook("onSend", async (request, reply, payload) => {
  reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (!request.url.startsWith("/api/") && !request.url.startsWith("/assets/") && !request.url.startsWith("/uploads/")) {
    reply.header("Cache-Control", "no-store, max-age=0");
  }
  return payload;
});
app.addHook("onRequest", async (request) => {
  request.log.info({ requestId: request.id, method: request.method, url: request.url }, "request.started");
});

await registerAuthRoutes(app);
await registerAuraRoutes(app);
await registerTradeRoutes(app);
await registerReadRoutes(app);
await registerAdminRoutes(app);
await registerProfileRoutes(app);
await registerVoteRoutes(app);
await registerChatGPTRoutes(app);
await registerAuraFarmingRoutes(app);
await registerDerivativesRoutes(app);

const uploadRoot = path.resolve("uploads");
await app.register(fastifyStatic, { root: uploadRoot, prefix: "/uploads/", decorateReply: false });

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "VALIDATION_ERROR", message: "Invalid request", details: error.issues });
  }
  if (error instanceof AppError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message, details: error.details });
  }
  if ((error as { code?: string }).code === "23505") {
    return reply.code(409).send({ error: "CONFLICT", message: "That value already exists" });
  }
  app.log.error(error);
  return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Something went sideways in the market" });
});

const webRoot = path.resolve("web/dist");
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "NOT_FOUND" });
    return reply.sendFile("index.html");
  });
}

await app.listen({ host: "0.0.0.0", port: config.PORT });

