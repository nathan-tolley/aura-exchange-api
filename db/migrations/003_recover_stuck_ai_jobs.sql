UPDATE jobs
   SET status='FAILED', updated_at=now()
 WHERE type='JUDGE_AURA'
   AND status='DONE'
   AND last_error IS NOT NULL;

INSERT INTO aura_rulings(
  submission_id, verdict, delta, confidence, rationale, category,
  provider, model, requires_review
)
SELECT s.id, 'REVIEW', 0, 0,
       'The judge could not reach a reliable ruling.', 'SYSTEM',
       'system', 'fallback', true
  FROM aura_submissions s
 WHERE s.status='JUDGING'
   AND EXISTS (
     SELECT 1 FROM jobs j
      WHERE j.type='JUDGE_AURA'
        AND j.payload->>'submissionId'=s.id::text
        AND j.status='FAILED'
        AND j.last_error IS NOT NULL
   )
   AND NOT EXISTS (
     SELECT 1 FROM aura_rulings r WHERE r.submission_id=s.id AND r.is_current
   );

UPDATE aura_submissions s
   SET status='REVIEW', updated_at=now()
 WHERE s.status='JUDGING'
   AND EXISTS (
     SELECT 1 FROM aura_rulings r
      WHERE r.submission_id=s.id AND r.is_current AND r.requires_review=true
   );
