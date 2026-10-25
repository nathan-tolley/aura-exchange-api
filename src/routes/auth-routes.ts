import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTransaction, pool, one, maybeOne } from "../db.js";
import {
  clearSessionCookie,
  guard,
  hashPassword,
  hashToken,
  issueSession,
  setSessionCookie,
  verifyPassword
} from "../auth.js";
import { accounts, postLedgerTransaction } from "../core/ledger.js";
import { badRequest, conflict, forbidden, unauthorized } from "../errors.js";
import { config } from "../config.js";
import { addMembership, legacyExchangeId } from "../services/exchange-service.js";

const credentialsSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(10).max(128)
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const sessionContext = (request: { headers: Record<string, unknown>; ip: string }) => ({
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
    ipAddress: request.ip
  });
  app.get("/api/setup/status", async () => {
    const result = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM memberships WHERE exchange_id=$1", [await legacyExchangeId(pool)]
    );
    return { needsSetup: Number(result.rows[0]?.count ?? 0) === 0 };
  });

  app.post("/api/setup/bootstrap", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } }
  }, async (request, reply) => {
    const input = z.object({
      setupToken: z.string(),
      displayName: z.string().trim().min(1).max(60),
      ticker: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,5}$/),
      username: credentialsSchema.shape.username,
      password: credentialsSchema.shape.password,
      consent: z.literal(true)
    }).parse(request.body);
    if (input.setupToken !== config.SETUP_TOKEN) throw forbidden("Invalid setup token");

    const result = await withTransaction(async (client) => {
      await client.query("LOCK TABLE memberships IN EXCLUSIVE MODE");
      const exchangeId = await legacyExchangeId(client);
      const existing = await client.query("SELECT 1 FROM memberships WHERE exchange_id=$1 LIMIT 1", [exchangeId]);
      if (existing.rowCount) throw conflict("Owner setup has already been completed");

      const user = await one<{ id: string }>(client,
        "INSERT INTO users(username, password_hash, role) VALUES ($1, $2, 'OWNER') RETURNING id",
        [input.username, await hashPassword(input.password)]
      );
      const stock = await one<{ id: string }>(client,
        `INSERT INTO listings(exchange_id, display_name, ticker, owner_user_id, is_active, claimed_at, consented_at)
         VALUES ($1, $2, $3, $4, true, now(), now()) RETURNING id`,
        [exchangeId, input.displayName, input.ticker, user.id]
      );
      await addMembership(client, exchangeId, user.id, "ADMIN", "now");
      const season = await one<{ id: string }>(client,
        `INSERT INTO seasons(exchange_id, season_number, name, starts_at, ends_at)
         VALUES ($1, 1, 'Season 1', now(), now() + interval '8 weeks') RETURNING id`, [exchangeId]
      );
      await client.query(
        "INSERT INTO market_pools(season_id, stock_id) VALUES ($1, $2)", [season.id, stock.id]
      );
      await postLedgerTransaction(client, "SEASON_GRANT", "Initial season balance", [
        { accountKey: accounts.userCash(user.id, season.id), amount: 10_000 },
        { accountKey: accounts.issuance(season.id), amount: -10_000 }
      ], user.id);
      await client.query(
        `INSERT INTO feed_events(season_id, kind, actor_id, subject_stock_id, payload)
         VALUES ($1, 'SEASON_STARTED', $2, $3, $4)`,
        [season.id, user.id, stock.id, JSON.stringify({ seasonName: "Season 1" })]
      );
      const session = await issueSession(client, user.id, sessionContext(request));
      return { ...session, userId: user.id };
    });

    setSessionCookie(reply, result.token);
    reply.code(201);
    return { ok: true, csrfToken: result.csrfToken };
  });

  app.post("/api/auth/login", {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } }
  }, async (request, reply) => {
    const input = credentialsSchema.parse(request.body);
    const user = await maybeOne<{
      id: string;
      password_hash: string;
      failed_login_count: number;
      locked_until: Date | null;
    }>(pool, "SELECT id, password_hash, failed_login_count, locked_until FROM users WHERE username = $1", [input.username]);

    if (!user || (user.locked_until && user.locked_until > new Date()) || !(await verifyPassword(user.password_hash, input.password))) {
      if (user) {
        await pool.query(
          `UPDATE users SET failed_login_count = failed_login_count + 1,
             locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
           WHERE id = $1`, [user.id]
        );
      }
      throw unauthorized("Invalid username or password");
    }

    const session = await withTransaction(async (client) => {
      await client.query("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1", [user.id]);
      return issueSession(client, user.id, sessionContext(request));
    });
    setSessionCookie(reply, session.token);
    return { ok: true, csrfToken: session.csrfToken };
  });

  app.post("/api/auth/claim", {
    config: { rateLimit: { max: 8, timeWindow: "15 minutes" } }
  }, async (request, reply) => {
    const input = credentialsSchema.extend({ claimCode: z.string().min(6).max(64), consent: z.literal(true) }).parse(request.body);
    const result = await withTransaction(async (client) => {
      const invite = await maybeOne<{ id: string; person_stock_id: string }>(client,
        `SELECT id, person_stock_id FROM invites
          WHERE code_hash = $1 AND person_stock_id IS NOT NULL AND used_at IS NULL AND expires_at > now()
          FOR UPDATE`, [hashToken(input.claimCode.trim().toUpperCase())]
      );
      if (!invite) throw badRequest("Claim code is invalid or expired", "INVALID_CLAIM_CODE");

      const user = await one<{ id: string }>(client,
        "INSERT INTO users(username, password_hash) VALUES ($1, $2) RETURNING id",
        [input.username, await hashPassword(input.password)]
      );
      const stock = await one<{ id: string; display_name: string; exchange_id: string }>(client,
        `UPDATE listings SET owner_user_id = $1, is_active = true, claimed_at = now(), consented_at = now(), updated_at = now()
          WHERE id = $2 AND owner_user_id IS NULL RETURNING id, display_name, exchange_id`,
        [user.id, invite.person_stock_id]
      );
      await addMembership(client, stock.exchange_id, user.id, "MEMBER", "now");
      await client.query("UPDATE invites SET used_at = now() WHERE id = $1", [invite.id]);
      const season = await one<{ id: string }>(client,
        "SELECT id FROM seasons WHERE exchange_id = $1 AND status = 'ACTIVE'", [stock.exchange_id]
      );
      await client.query("INSERT INTO market_pools(season_id, stock_id) VALUES ($1, $2)", [season.id, stock.id]);
      await postLedgerTransaction(client, "SEASON_GRANT", "Initial season balance", [
        { accountKey: accounts.userCash(user.id, season.id), amount: 10_000 },
        { accountKey: accounts.issuance(season.id), amount: -10_000 }
      ], user.id);
      await client.query(
        `INSERT INTO feed_events(season_id, kind, actor_id, subject_stock_id, payload)
         VALUES ($1, 'MEMBER_JOINED', $2, $3, $4)`,
        [season.id, user.id, stock.id, JSON.stringify({ displayName: stock.display_name })]
      );
      return issueSession(client, user.id, sessionContext(request));
    });
    setSessionCookie(reply, result.token);
    reply.code(201);
    return { ok: true, csrfToken: result.csrfToken };
  });

  app.post("/api/auth/reset", {
    config: { rateLimit: { max: 6, timeWindow: "15 minutes" } }
  }, async (request) => {
    const input = z.object({
      username: credentialsSchema.shape.username,
      resetCode: z.string().min(6).max(64),
      newPassword: credentialsSchema.shape.password
    }).parse(request.body);
    await withTransaction(async (client) => {
      const token = await maybeOne<{ id: string; user_id: string }>(client,
        `SELECT pr.id,pr.user_id FROM password_reset_tokens pr JOIN users u ON u.id=pr.user_id
          WHERE u.username=$1 AND pr.code_hash=$2 AND pr.used_at IS NULL AND pr.expires_at>now() FOR UPDATE`,
        [input.username, hashToken(input.resetCode.trim().toUpperCase())]
      );
      if (!token) throw badRequest("Reset code is invalid or expired", "INVALID_RESET_CODE");
      await client.query("UPDATE users SET password_hash=$1,failed_login_count=0,locked_until=NULL,updated_at=now() WHERE id=$2", [await hashPassword(input.newPassword), token.user_id]);
      await client.query("UPDATE password_reset_tokens SET used_at=now() WHERE id=$1", [token.id]);
      await client.query("DELETE FROM sessions WHERE user_id=$1", [token.user_id]);
    });
    return { ok: true };
  });

  app.get("/api/auth/session", { preHandler: guard() }, async (request) => ({ user: request.auth }));

  app.get("/api/auth/sessions", { preHandler: guard() }, async (request) => {
    const currentHash = request.cookies.aura_session ? hashToken(request.cookies.aura_session) : "";
    const result = await pool.query(
      `SELECT id,user_agent,host(ip_address) AS ip_address,created_at,last_seen_at,expires_at,
              token_hash=$2 AS is_current
         FROM sessions
        WHERE user_id=$1 AND expires_at>now() AND revoked_at IS NULL
        ORDER BY last_seen_at DESC`,
      [request.auth!.id, currentHash]
    );
    return { items: result.rows };
  });

  app.post("/api/auth/sessions/:id/revoke", { preHandler: guard({ csrf: true }) }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const currentHash = request.cookies.aura_session ? hashToken(request.cookies.aura_session) : "";
    const result = await pool.query<{ is_current:boolean }>(
      `UPDATE sessions SET revoked_at=now()
        WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL
        RETURNING token_hash=$3 AS is_current`,
      [params.id, request.auth!.id, currentHash]
    );
    if (!result.rowCount) throw badRequest("Session is no longer active", "SESSION_INACTIVE");
    if (result.rows[0]?.is_current) clearSessionCookie(reply);
    await pool.query(
      "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES ($1,'SESSION_REVOKED','SESSION',$2)",
      [request.auth!.id, params.id]
    );
    return { ok: true, signedOut: Boolean(result.rows[0]?.is_current) };
  });

  app.post("/api/auth/logout", { preHandler: guard({ csrf: true }) }, async (request, reply) => {
    const token = request.cookies.aura_session;
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    clearSessionCookie(reply);
    return { ok: true };
  });
}

