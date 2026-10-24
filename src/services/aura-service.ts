import type { PoolClient } from "pg";
import { createAuraJudge } from "../ai/judge.js";
import { one, withTransaction } from "../db.js";
import { notifyStockOwner } from "./notification-service.js";

const hardFlags = new Set([
  "credible_threat",
  "personal_data",
  "illegal_content",
  "protected_class_attack",
  "sexual_exploitation",
  "targeted_harassment"
]);

interface SubmissionRow {
  id: string;
  season_id: string;
  author_id: string;
  subject_stock_id: string;
  explanation: string;
  status: string;
}

export async function applyAuraEntry(
  client: PoolClient,
  submission: SubmissionRow,
  rulingId: string,
  delta: number,
  rationale: string,
  createdBy?: string
): Promise<void> {
  const entry = await one<{ id: string }>(client,
    `INSERT INTO aura_ledger_entries(season_id, stock_id, submission_id, ruling_id, delta, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [submission.season_id, submission.subject_stock_id, submission.id, rulingId, delta, rationale, createdBy ?? null]
  );
  await client.query(
    `UPDATE person_stocks SET seasonal_aura = seasonal_aura + $1, career_aura = career_aura + $1, updated_at = now()
      WHERE id = $2`, [delta, submission.subject_stock_id]
  );
  await client.query("UPDATE aura_submissions SET status = 'APPLIED', updated_at = now() WHERE id = $1", [submission.id]);
  await client.query(
    `INSERT INTO feed_events(season_id, kind, actor_id, subject_stock_id, payload)
     VALUES ($1, 'AURA_RULING', $2, $3, $4)`,
    [submission.season_id, submission.author_id, submission.subject_stock_id, JSON.stringify({
      submissionId: submission.id,
      rulingId,
      ledgerEntryId: entry.id,
      explanation: submission.explanation,
      delta,
      rationale,
      authorId: submission.author_id
    })]
  );
  await notifyStockOwner(client, submission.subject_stock_id, "AURA_RULING", { submissionId: submission.id, delta, rationale });
}

export async function processAuraSubmission(
  submissionId: string,
  options: { finalReconsideration?: boolean; priorRuling?: { verdict: "GAIN"|"LOSS"|"NEUTRAL"|"REVIEW"; delta: number; rationale: string } } = {}
): Promise<void> {
  const submission = await withTransaction(async (client) => {
    const row = await one<SubmissionRow>(client,
      "SELECT * FROM aura_submissions WHERE id = $1 FOR UPDATE", [submissionId]
    );
    if (!["PENDING", "FAILED"].includes(row.status)) return null;
    await client.query("UPDATE aura_submissions SET status = 'JUDGING', updated_at = now() WHERE id = $1", [submissionId]);
    return row;
  });
  if (!submission) return;

  const glossaryResult = await withTransaction(async (client) => client.query<{ phrase: string; explanation: string }>(
    `SELECT phrase::text, explanation FROM glossary_entries
      WHERE position(lower(phrase::text) in lower($1)) > 0 LIMIT 8`, [submission.explanation]
  ));

  const judge = await createAuraJudge();
  const result = await judge.judge({
    subjectKey: `stock_${submission.subject_stock_id.slice(0, 8)}`,
    explanation: submission.explanation,
    glossary: glossaryResult.rows,
    reconsideration: options.priorRuling ? {
      priorVerdict: options.priorRuling.verdict,
      priorDelta: options.priorRuling.delta,
      priorRationale: options.priorRuling.rationale
    } : undefined
  });
  const hasHardFlag = result.policyFlags.some((flag) => hardFlags.has(flag));
  const isMajorSwing = Math.abs(result.delta) > 15;
  const requiresReview = hasHardFlag || result.verdict === "REVIEW" || result.confidence < 0.75;

  await withTransaction(async (client) => {
    const current = await one<SubmissionRow>(client,
      "SELECT * FROM aura_submissions WHERE id = $1 FOR UPDATE", [submission.id]
    );
    if (current.status !== "JUDGING") return;
    const ruling = await one<{ id: string }>(client,
      `INSERT INTO aura_rulings(
         submission_id, verdict, delta, confidence, rationale, category, policy_flags,
         provider, model, provider_request_id, requires_review
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [submission.id, result.verdict, result.delta, result.confidence, result.rationale, result.category,
        JSON.stringify(result.policyFlags), result.provider, result.model, result.requestId ?? null, requiresReview]
    );
    if (requiresReview) {
      await client.query("UPDATE aura_submissions SET status = 'REVIEW', updated_at = now() WHERE id = $1", [submission.id]);
    } else if (isMajorSwing && !options.finalReconsideration) {
      await client.query(
        `INSERT INTO aura_swing_polls(submission_id,ruling_id) VALUES ($1,$2)`,
        [submission.id, ruling.id]
      );
      await client.query("UPDATE aura_submissions SET status='FARMING',updated_at=now() WHERE id=$1", [submission.id]);
    } else {
      await applyAuraEntry(client, submission, ruling.id, result.delta, result.rationale);
    }
  });
}

