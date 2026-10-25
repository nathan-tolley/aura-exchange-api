import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { maybeOne, pool, withTransaction } from "../db.js";
import { appError } from "../errors.js";
import type { EmailSender } from "../services/email-sender.js";
import { type AppUserRow, checkLoginCode, findOrCreateEmailUser, issueLoginCode, normalizeEmail } from "../services/login-code-service.js";
import { issueTokenPair, revokeFamily, rotateRefreshToken } from "../services/token-service.js";
import { serializeUser } from "./serialize.js";

export interface AuthRouteOptions {
  emailSender: EmailSender;
  /** Sign-in codes one IP may request per hour, across all emails. */
  loginCodesPerIpPerHour: number;
}

const email = z.email().max(254);
const refreshToken = z.string().min(10).max(200);
const userAgentOf = (request: FastifyRequest) => {
  const header = request.headers["user-agent"];
  return typeof header === "string" ? header : undefined;
};

export async function registerAuthRoutes(v1: FastifyInstance, options: AuthRouteOptions): Promise<void> {
  // Always 204, whether or not an account exists, so the endpoint can't be used to discover who plays.
  v1.post("/auth/email/start", {
    config: { public: true, rateLimit: { max: options.loginCodesPerIpPerHour, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    const input = z.object({ email }).parse(request.body);
    const result = await issueLoginCode(pool, input.email, request.ip);
    if (!result.issued) {
      throw appError("RATE_LIMITED", { retryAfterSeconds: String(result.retryAfterSeconds) }, "Too many sign-in codes for this email; try again later");
    }
    await options.emailSender.sendLoginCode(normalizeEmail(input.email), result.code);
    return reply.code(204).send();
  });

  // Signing in with a new email creates the account.
  v1.post("/auth/email/verify", { config: { public: true } }, async (request) => {
    const input = z.object({ email, code: z.string().regex(/^\d{6}$/) }).parse(request.body);
    const outcome = await withTransaction(async (client) => {
      const check = await checkLoginCode(client, input.email, input.code);
      if (!check.ok) return check;
      const user = await findOrCreateEmailUser(client, input.email);
      const pair = await issueTokenPair(client, user.id, { userAgent: userAgentOf(request) });
      return { ok: true as const, user, pair };
    });
    if (!outcome.ok) {
      throw outcome.reason === "EXPIRED"
        ? appError("LOGIN_CODE_EXPIRED", {}, "This code has expired or used up its tries; request a new one")
        : appError("LOGIN_CODE_INVALID", { attemptsLeft: String(outcome.attemptsLeft) }, "That code is not right");
    }
    return { ...outcome.pair, user: serializeUser(outcome.user) };
  });

  v1.post("/auth/refresh", { config: { public: true } }, async (request) => {
    const input = z.object({ refreshToken }).parse(request.body);
    const outcome = await withTransaction((client) => rotateRefreshToken(client, input.refreshToken, userAgentOf(request)));
    if (!outcome.ok) throw appError("AUTH_EXPIRED", {}, "Sign in again");
    const user = await maybeOne<AppUserRow>(pool, "SELECT id,email::text,display_name,username::text,created_at FROM users WHERE id=$1", [outcome.userId]);
    if (!user) throw appError("AUTH_EXPIRED", {}, "This account no longer exists");
    return { ...outcome.pair, user: serializeUser(user) };
  });

  v1.post("/auth/logout", async (request, reply) => {
    const input = z.object({ refreshToken }).parse(request.body);
    await revokeFamily(pool, input.refreshToken, request.v1User!.id);
    return reply.code(204).send();
  });
}
