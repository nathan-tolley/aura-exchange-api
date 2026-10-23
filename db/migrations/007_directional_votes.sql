-- Earlier voting multiplied the ruling's signed delta. Correct existing votes on
-- negative rulings so up always adds Aura and down always removes it.
WITH corrections AS (
  SELECT f.season_id,
         f.subject_stock_id AS stock_id,
         (f.payload->>'submissionId')::uuid AS submission_id,
         (f.payload->>'rulingId')::uuid AS ruling_id,
         v.voter_id,
         (abs((f.payload->>'delta')::numeric) * 0.20 * v.direction)::numeric(12,2) AS delta
    FROM aura_votes v
    JOIN feed_events f ON f.id=v.feed_event_id
   WHERE f.kind='AURA_RULING'
     AND (f.payload->>'delta')::numeric < 0
), inserted AS (
  INSERT INTO aura_ledger_entries(season_id,stock_id,submission_id,ruling_id,delta,reason,created_by)
  SELECT season_id,stock_id,submission_id,ruling_id,delta,
         'Directional vote semantics correction',voter_id
    FROM corrections
   WHERE delta <> 0
  RETURNING stock_id,delta
), totals AS (
  SELECT stock_id,sum(delta) AS delta FROM inserted GROUP BY stock_id
)
UPDATE person_stocks ps
   SET seasonal_aura=ps.seasonal_aura+totals.delta,
       career_aura=ps.career_aura+totals.delta,
       updated_at=now()
  FROM totals
 WHERE ps.id=totals.stock_id;
