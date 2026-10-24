import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { guard, hashToken } from "../auth.js";
import { pool, one, withTransaction } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { delistStock } from "../services/delisting-service.js";

const claimCode = () => randomBytes(6).toString("base64url").toUpperCase();

/** Admin actions on a listing or user only reach the console's own exchange. */
async function assertListingInExchange(client: Pick<PoolClient, "query">, listingId: string, exchangeId: string): Promise<void> {
  const found = await client.query("SELECT 1 FROM listings WHERE id=$1 AND exchange_id=$2", [listingId, exchangeId]);
  if (!found.rowCount) throw notFound("That person is not on this exchange");
}

async function assertMemberOfExchange(client: Pick<PoolClient, "query">, userId: string, exchangeId: string): Promise<void> {
  const found = await client.query("SELECT 1 FROM memberships WHERE user_id=$1 AND exchange_id=$2", [userId, exchangeId]);
  if (!found.rowCount) throw notFound("That user is not on this exchange");
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/diagnostics/jobs", { preHandler: guard({ roles: ["OWNER", "MODERATOR"] }) }, async () => {
    const result = await pool.query(
      `SELECT id,type,status,attempts,run_after,locked_at,locked_by,last_error,created_at,updated_at,
              payload-'explanation' AS payload
         FROM jobs WHERE status IN ('PENDING','RUNNING','FAILED')
        ORDER BY CASE status WHEN 'FAILED' THEN 0 WHEN 'RUNNING' THEN 1 ELSE 2 END,created_at LIMIT 100`
    );
    return { items: result.rows };
  });

  app.get("/api/admin/export", { preHandler: guard({ roles: ["OWNER"] }) }, async (request, reply) => {
    const auth=request.auth!,exchange=[auth.exchangeId];
    const [users,people,seasons,submissions,rulings,auraLedger,trades,positions,orders,cashLedger] = await Promise.all([
      pool.query("SELECT u.id,u.username::text,u.role,u.created_at FROM users u JOIN memberships m ON m.user_id=u.id AND m.exchange_id=$1 ORDER BY u.created_at",exchange),
      pool.query("SELECT id,display_name,ticker::text,is_active,seasonal_aura,career_aura,claimed_at,consented_at,opted_out_at FROM listings WHERE exchange_id=$1 ORDER BY display_name",exchange),
      pool.query("SELECT * FROM seasons WHERE exchange_id=$1 ORDER BY season_number",exchange),
      pool.query("SELECT id,season_id,subject_stock_id,status,created_at,updated_at FROM aura_submissions WHERE exchange_id=$1 ORDER BY created_at",exchange),
      pool.query("SELECT id,submission_id,verdict,delta,confidence,rationale,category,policy_flags,provider,model,requires_review,created_at FROM aura_rulings WHERE exchange_id=$1 ORDER BY created_at",exchange),
      pool.query("SELECT * FROM aura_ledger_entries WHERE exchange_id=$1 ORDER BY created_at",exchange),
      pool.query("SELECT * FROM trades WHERE exchange_id=$1 ORDER BY created_at",exchange),
      pool.query("SELECT * FROM positions WHERE exchange_id=$1 ORDER BY season_id,user_id,stock_id",exchange),
      pool.query("SELECT * FROM limit_orders WHERE exchange_id=$1 ORDER BY created_at",exchange),
      // Every account key ends in its season id, and a season belongs to one exchange.
      pool.query(`SELECT cle.*,lt.kind,lt.reference_id,lt.description FROM cash_ledger_entries cle JOIN ledger_transactions lt ON lt.id=cle.transaction_id
                   WHERE right(cle.account_key,36) IN (SELECT id::text FROM seasons WHERE exchange_id=$1) ORDER BY cle.created_at`,exchange)
    ]);
    await pool.query("INSERT INTO audit_logs(actor_id,action,entity_type,metadata) VALUES ($1,'ADMIN_EXPORT','SYSTEM',$2)",[auth.id,JSON.stringify({format:"json"})]);
    reply.header("Content-Disposition",`attachment; filename="aura-exchange-export-${new Date().toISOString().slice(0,10)}.json"`);
    return { exportedAt:new Date().toISOString(),users:users.rows,people:people.rows,seasons:seasons.rows,submissions:submissions.rows,rulings:rulings.rows,auraLedger:auraLedger.rows,trades:trades.rows,positions:positions.rows,orders:orders.rows,cashLedger:cashLedger.rows };
  });
  app.get("/api/admin/roster", { preHandler: guard({ roles: ["OWNER", "MODERATOR"] }) }, async (request) => {
    const result = await pool.query(
      `SELECT ps.id, ps.display_name, ps.ticker::text, ps.is_active, ps.claimed_at, ps.consented_at,
              ps.seasonal_aura, ps.career_aura, u.id AS user_id, u.username::text, u.role
         FROM listings ps LEFT JOIN users u ON u.id=ps.owner_user_id WHERE ps.exchange_id=$1 ORDER BY ps.display_name`,
      [request.auth!.exchangeId]
    );
    return { people: result.rows };
  });

  app.post("/api/admin/roster", { preHandler: guard({ roles: ["OWNER", "MODERATOR"], csrf: true }) }, async (request, reply) => {
    const input = z.object({
      displayName: z.string().trim().min(1).max(60),
      ticker: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,5}$/)
    }).parse(request.body);
    const auth = request.auth!;
    const code = claimCode();
    const result = await withTransaction(async (client) => {
      try {
        const stock = await one<{ id: string }>(client,
          "INSERT INTO listings(exchange_id, display_name, ticker) VALUES ($1,$2,$3) RETURNING id",
          [auth.exchangeId, input.displayName, input.ticker]
        );
        await client.query(
          `INSERT INTO invites(person_stock_id, code_hash, expires_at, created_by)
           VALUES ($1,$2,now() + interval '30 days',$3)`, [stock.id, hashToken(code), auth.id]
        );
        await client.query(
          "INSERT INTO audit_logs(actor_id, action, entity_type, entity_id, metadata) VALUES ($1,'ROSTER_CREATED','PERSON_STOCK',$2,$3)",
          [auth.id, stock.id, JSON.stringify({ ticker: input.ticker })]
        );
        return stock;
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw conflict("Ticker already exists", "DUPLICATE_TICKER");
        throw error;
      }
    });
    reply.code(201);
    return { ...result, claimCode: code, expiresInDays: 30 };
  });

  app.post("/api/admin/roster/:id/invite", { preHandler: guard({ roles: ["OWNER", "MODERATOR"], csrf: true }) }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const auth = request.auth!;
    const code = claimCode();
    await withTransaction(async (client) => {
      await assertListingInExchange(client, params.id, auth.exchangeId);
      await client.query("UPDATE invites SET expires_at=now() WHERE person_stock_id=$1 AND used_at IS NULL", [params.id]);
      await client.query(
        "INSERT INTO invites(person_stock_id, code_hash, expires_at, created_by) VALUES ($1,$2,now()+interval '30 days',$3)",
        [params.id, hashToken(code), auth.id]
      );
      await client.query("INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES ($1,'INVITE_ISSUED','PERSON_STOCK',$2)",[auth.id,params.id]);
    });
    return { claimCode: code, expiresInDays: 30 };
  });

  app.post("/api/admin/users/:id/reset-code", { preHandler: guard({ roles: ["OWNER", "MODERATOR"], csrf: true }) }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const code = claimCode();
    await withTransaction(async (client) => {
      await assertMemberOfExchange(client, params.id, request.auth!.exchangeId);
      await client.query("UPDATE password_reset_tokens SET expires_at=now() WHERE user_id=$1 AND used_at IS NULL", [params.id]);
      await client.query(
        `INSERT INTO password_reset_tokens(user_id,code_hash,expires_at,created_by)
         VALUES ($1,$2,now()+interval '30 minutes',$3)`, [params.id, hashToken(code), request.auth!.id]
      );
      await client.query(
        "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES ($1,'PASSWORD_RESET_ISSUED','USER',$2)",
        [request.auth!.id, params.id]
      );
    });
    return { resetCode: code, expiresInMinutes: 30 };
  });

  app.post("/api/admin/roster/:id/delist", { preHandler: guard({ roles: ["OWNER", "MODERATOR"], csrf: true }) }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await withTransaction(async (client) => {
      await assertListingInExchange(client, params.id, request.auth!.exchangeId);
      await delistStock(client, params.id, request.auth!.id);
    });
    return { ok: true };
  });

  app.post("/api/profile/opt-out", { preHandler: guard({ csrf: true }) }, async (request) => {
    const input = z.object({ confirm: z.literal(true) }).parse(request.body);
    void input;
    const auth = request.auth!;
    if (!auth.stockId) throw conflict("Your account has no listing");
    await withTransaction((client) => delistStock(client, auth.stockId!, auth.id));
    return { ok: true };
  });

  app.get("/api/admin/glossary", { preHandler: guard({ roles: ["OWNER", "MODERATOR"] }) }, async (request) => {
    const result = await pool.query("SELECT id, phrase::text, explanation, created_at FROM glossary_entries WHERE exchange_id=$1 ORDER BY phrase", [request.auth!.exchangeId]);
    return { entries: result.rows };
  });

  app.post("/api/admin/glossary", { preHandler: guard({ roles: ["OWNER", "MODERATOR"], csrf: true }) }, async (request, reply) => {
    const input = z.object({ phrase: z.string().trim().min(1).max(80), explanation: z.string().trim().min(1).max(280) }).parse(request.body);
    const row = await one(pool,
      "INSERT INTO glossary_entries(exchange_id, phrase, explanation, created_by) VALUES ($1,$2,$3,$4) RETURNING id, phrase::text, explanation",
      [request.auth!.exchangeId, input.phrase, input.explanation, request.auth!.id]
    );
    await pool.query("INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES ($1,'GLOSSARY_CREATED','GLOSSARY_ENTRY',$2)",[request.auth!.id,(row as {id:string}).id]);
    reply.code(201);
    return row;
  });
}

