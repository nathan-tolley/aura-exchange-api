import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guard } from "../auth.js";
import { pool, one, maybeOne, withTransaction } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { applyAuraEntry } from "../services/aura-service.js";

export const DAILY_AURA_SUBMISSION_LIMIT = 10;

const eventSchema = z.object({
  subjectId: z.string().uuid(),
  explanation: z.string().trim().min(8).max(800)
});

export async function registerAuraRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/aura-events", { preHandler: guard({ csrf: true }) }, async (request, reply) => {
    const input = eventSchema.parse(request.body);
    const auth = request.auth!;
    if (auth.stockId === input.subjectId) throw forbidden("You cannot submit Aura about yourself");
    const normalized = input.explanation.toLowerCase().replace(/\s+/g, " ").trim();
    const contentHash = createHash("sha256").update(normalized).digest("hex");

    const submission = await withTransaction(async (client) => {
      const subject = await maybeOne<{ id: string }>(client,
        "SELECT id FROM listings WHERE id = $1 AND exchange_id = $2 AND is_active = true AND consented_at IS NOT NULL", [input.subjectId, auth.exchangeId]
      );
      if (!subject) throw notFound("That Aura stock is not active");
      const season = await one<{ id: string }>(client, "SELECT id FROM seasons WHERE exchange_id = $1 AND status = 'ACTIVE'", [auth.exchangeId]);
      const rates = await one<{ total: string }>(client,
        `SELECT COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::text AS total
           FROM aura_submissions WHERE author_id = $1 AND exchange_id = $2`, [auth.id, auth.exchangeId]
      );
      if (Number(rates.total) >= DAILY_AURA_SUBMISSION_LIMIT) {
        throw badRequest(`Daily Aura submission limit of ${DAILY_AURA_SUBMISSION_LIMIT} reached`, "RATE_LIMITED");
      }
      try {
        return await one<{ id: string }>(client,
          `INSERT INTO aura_submissions(season_id, author_id, subject_stock_id, explanation, content_hash)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [season.id, auth.id, input.subjectId, input.explanation, contentHash]
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw conflict("You already submitted this event", "DUPLICATE_EVENT");
        throw error;
      }
    });
    await pool.query("INSERT INTO jobs(type, payload) VALUES ('JUDGE_AURA', $1)", [JSON.stringify({ submissionId: submission.id })]);
    reply.code(202);
    return { id: submission.id, status: "PENDING" };
  });

  app.post("/api/aura-events/:id/appeal", { preHandler: guard({ csrf: true }) }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ reason: z.string().trim().min(8).max(800) }).parse(request.body);
    const auth = request.auth!;
    const result = await withTransaction(async (client) => {
      const submission = await maybeOne<{ id: string; subject_stock_id: string; created_at: Date }>(client,
        `SELECT s.id, s.subject_stock_id, s.created_at FROM aura_submissions s
          JOIN listings ps ON ps.id = s.subject_stock_id
         WHERE s.id = $1 AND ps.owner_user_id = $2 AND s.exchange_id = $3 AND s.created_at >= now() - interval '7 days'`,
        [params.id, auth.id, auth.exchangeId]
      );
      if (!submission) throw forbidden("Only the subject can appeal within seven days");
      const appeal = await one<{ id: string }>(client,
        "INSERT INTO appeals(submission_id, appellant_id, reason) VALUES ($1,$2,$3) RETURNING id",
        [submission.id, auth.id, input.reason]
      );
      await client.query("UPDATE aura_submissions SET status = 'APPEALED', updated_at = now() WHERE id = $1", [submission.id]);
      const season = await one<{ id: string }>(client, "SELECT season_id AS id FROM aura_submissions WHERE id = $1", [submission.id]);
      await client.query(
        `INSERT INTO feed_events(season_id, kind, actor_id, subject_stock_id, payload)
         VALUES ($1, 'AURA_APPEALED', $2, $3, $4)`,
        [season.id, auth.id, submission.subject_stock_id, JSON.stringify({ submissionId: submission.id })]
      );
      return appeal;
    });
    reply.code(201);
    return result;
  });

  app.get("/api/moderation/review", { preHandler: guard({ roles: ["OWNER", "MODERATOR"] }) }, async (request) => {
    const result = await pool.query(
      `SELECT s.id, s.status, s.explanation, s.created_at, ps.display_name, ps.ticker::text,
              r.id AS ruling_id, r.verdict, r.delta, r.confidence, r.rationale, r.category, r.policy_flags,
              r.provider, r.model,
              CASE WHEN latest_job.last_error ILIKE '%no credits remaining%' THEN 'OpenAI API credits are exhausted.'
                   WHEN latest_job.last_error IS NOT NULL THEN 'The AI provider could not complete this ruling.' END AS ai_error
         FROM aura_submissions s
         JOIN listings ps ON ps.id = s.subject_stock_id
         LEFT JOIN aura_rulings r ON r.submission_id = s.id AND r.is_current
         LEFT JOIN LATERAL (
           SELECT j.last_error FROM jobs j
            WHERE j.type='JUDGE_AURA' AND j.payload->>'submissionId'=s.id::text
            ORDER BY j.created_at DESC LIMIT 1
         ) latest_job ON true
        WHERE s.status IN ('REVIEW', 'APPEALED') AND s.exchange_id = $1 ORDER BY s.created_at`, [request.auth!.exchangeId]
    );
    return { items: result.rows };
  });

  app.post("/api/moderation/review/:id", {
    preHandler: guard({ roles: ["OWNER", "MODERATOR"], csrf: true })
  }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({
      action: z.enum(["APPROVE", "ADJUST", "REJECT", "OVERTURN", "RETRY"]),
      delta: z.number().int().min(-30).max(30).optional(),
      note: z.string().trim().min(2).max(500)
    }).parse(request.body);
    const auth = request.auth!;

    await withTransaction(async (client) => {
      const submission = await one<{
        id: string; season_id: string; author_id: string; subject_stock_id: string; explanation: string; status: string;
      }>(client, "SELECT * FROM aura_submissions WHERE id = $1 AND exchange_id = $2 FOR UPDATE", [params.id, auth.exchangeId]);
      const ruling = await maybeOne<{ id: string; delta: number; rationale: string; provider: string }>(client,
        "SELECT id, delta, rationale, provider FROM aura_rulings WHERE submission_id = $1 AND is_current", [params.id]
      );
      if (!ruling) throw badRequest("Submission has no ruling");

      if (input.action === "RETRY") {
        await client.query("UPDATE aura_rulings SET is_current=false, reviewed_by=$1, reviewed_at=now() WHERE id=$2", [auth.id, ruling.id]);
        await client.query("UPDATE aura_submissions SET status='PENDING',updated_at=now() WHERE id=$1", [params.id]);
        await client.query("INSERT INTO jobs(type,payload) VALUES ('JUDGE_AURA',$1)", [JSON.stringify({ submissionId: params.id })]);
      } else if (input.action === "REJECT") {
        await client.query("UPDATE aura_submissions SET status = 'REJECTED', hidden_at = now(), updated_at = now() WHERE id = $1", [params.id]);
      } else if (input.action === "OVERTURN") {
        const previous = await maybeOne<{ id: string; delta: number }>(client,
          "SELECT id, delta FROM aura_ledger_entries WHERE submission_id = $1 AND reversal_of IS NULL ORDER BY created_at LIMIT 1", [params.id]
        );
        if (previous) {
          await client.query(
            `INSERT INTO aura_ledger_entries(season_id, stock_id, submission_id, ruling_id, reversal_of, delta, reason, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [submission.season_id, submission.subject_stock_id, submission.id, ruling.id, previous.id, -previous.delta, input.note, auth.id]
          );
          await client.query(
            "UPDATE listings SET seasonal_aura = seasonal_aura - $1, career_aura = career_aura - $1 WHERE id = $2",
            [previous.delta, submission.subject_stock_id]
          );
        }
        await client.query("UPDATE aura_submissions SET status = 'OVERTURNED', updated_at = now() WHERE id = $1", [params.id]);
        await client.query("UPDATE appeals SET status = 'OVERTURNED', resolved_by = $1, resolution_note = $2, resolved_at = now() WHERE submission_id = $3 AND status = 'PENDING'", [auth.id, input.note, params.id]);
      } else {
        const delta = input.action === "ADJUST" ? input.delta : ruling.delta;
        if (delta === undefined) throw badRequest("Adjusted rulings require a delta");
        const existing = await client.query("SELECT 1 FROM aura_ledger_entries WHERE submission_id = $1 AND reversal_of IS NULL", [params.id]);
        if (!existing.rowCount) await applyAuraEntry(client, submission, ruling.id, delta, input.note, auth.id);
        await client.query("UPDATE appeals SET status = 'UPHELD', resolved_by = $1, resolution_note = $2, resolved_at = now() WHERE submission_id = $3 AND status = 'PENDING'", [auth.id, input.note, params.id]);
      }
      if (input.action !== "RETRY") await client.query(
        "UPDATE aura_rulings SET reviewed_by = $1, reviewed_at = now() WHERE id = $2", [auth.id, ruling.id]
      );
      await client.query(
        `INSERT INTO moderation_actions(exchange_id, moderator_id, action, target_type, target_id, reason)
         SELECT exchange_id,$1,$2,'AURA_SUBMISSION',id,$3 FROM aura_submissions WHERE id=$4`, [auth.id, input.action, input.note, params.id]
      );
    });
    return { ok: true };
  });
}

