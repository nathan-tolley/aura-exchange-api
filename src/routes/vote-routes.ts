import { Decimal } from "decimal.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guard } from "../auth.js";
import { effectiveAuraDelta, type AuraVote, voteAdjustment } from "../core/aura-voting.js";
import { maybeOne, one, withTransaction } from "../db.js";
import { badRequest, forbidden, notFound } from "../errors.js";

interface VoteEvent {
  id: string;
  season_id: string;
  subject_stock_id: string;
  payload: Record<string, unknown>;
  submission_status: string;
}

export async function registerVoteRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/feed/:id/vote", { preHandler: guard({ csrf: true }) }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]) }).parse(request.body);
    const auth = request.auth!;

    return withTransaction(async (client) => {
      const event = await maybeOne<VoteEvent>(client,
        `SELECT f.id, f.season_id, f.subject_stock_id, f.payload, s.status AS submission_status
           FROM feed_events f
           JOIN aura_submissions s ON s.id = (f.payload->>'submissionId')::uuid
          WHERE f.id=$1 AND f.exchange_id=$2 AND f.kind='AURA_RULING' AND f.hidden_at IS NULL
          FOR UPDATE OF f`, [params.id, auth.exchangeId]
      );
      if (!event || !event.season_id || !event.subject_stock_id) throw notFound("That Aura ruling is not available for voting");
      if (["REJECTED", "OVERTURNED"].includes(event.submission_status)) throw badRequest("That Aura ruling is closed to voting");
      if (event.subject_stock_id === auth.stockId) throw forbidden("You cannot vote on Aura about yourself");

      const baseDelta = new Decimal(String(event.payload.delta ?? 0));
      if (!baseDelta.isFinite() || baseDelta.isZero()) throw badRequest("Neutral rulings cannot be voted on");
      const submissionId = String(event.payload.submissionId ?? "");
      const rulingId = String(event.payload.rulingId ?? "");
      if (!z.string().uuid().safeParse(submissionId).success || !z.string().uuid().safeParse(rulingId).success) {
        throw badRequest("That Aura ruling is missing ledger references");
      }

      const existing = await maybeOne<{ direction: number }>(client,
        "SELECT direction FROM aura_votes WHERE feed_event_id=$1 AND voter_id=$2 FOR UPDATE",
        [event.id, auth.id]
      );
      const previousVote = (existing?.direction ?? 0) as AuraVote;
      const nextVote = input.direction as AuraVote;
      const adjustment = voteAdjustment(baseDelta, previousVote, nextVote);

      if (nextVote === 0) {
        await client.query("DELETE FROM aura_votes WHERE feed_event_id=$1 AND voter_id=$2", [event.id, auth.id]);
      } else {
        await client.query(
          `INSERT INTO aura_votes(feed_event_id, voter_id, direction)
           VALUES ($1,$2,$3)
           ON CONFLICT(feed_event_id,voter_id) DO UPDATE SET direction=EXCLUDED.direction, updated_at=now()`,
          [event.id, auth.id, nextVote]
        );
      }

      if (!adjustment.isZero()) {
        await client.query(
          `INSERT INTO aura_ledger_entries(season_id, stock_id, submission_id, ruling_id, delta, reason, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [event.season_id, event.subject_stock_id, submissionId, rulingId, adjustment.toFixed(2),
            `Community vote changed from ${previousVote} to ${nextVote}`, auth.id]
        );
        await client.query(
          `UPDATE listings
              SET seasonal_aura=seasonal_aura+$1, career_aura=career_aura+$1, updated_at=now()
            WHERE id=$2`, [adjustment.toFixed(2), event.subject_stock_id]
        );
      }

      const counts = await one<{ upvotes: number; downvotes: number; vote_score: number }>(client,
        `SELECT COUNT(*) FILTER (WHERE direction=1)::int AS upvotes,
                COUNT(*) FILTER (WHERE direction=-1)::int AS downvotes,
                COALESCE(SUM(direction),0)::int AS vote_score
           FROM aura_votes WHERE feed_event_id=$1`, [event.id]
      );
      return {
        votes: {
          up: counts.upvotes,
          down: counts.downvotes,
          viewerVote: nextVote,
          effectiveDelta: effectiveAuraDelta(baseDelta, counts.vote_score)
        }
      };
    });
  });
}
