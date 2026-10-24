-- Scheduled jobs now run per exchange, and their run-once keys carry the exchange id
-- ("allowance:<exchange>:2026-10-26" instead of "allowance:2026-10-26"). Copy every key already
-- completed into the Default exchange's form, so a deploy in the middle of a Monday doesn't grant
-- the allowance, dividends or borrow fees a second time.
INSERT INTO scheduled_runs(key, completed_at)
SELECT split_part(sr.key, ':', 1) || ':' || e.id::text || ':' || substr(sr.key, length(split_part(sr.key, ':', 1)) + 2),
       sr.completed_at
  FROM scheduled_runs sr
 CROSS JOIN (SELECT id FROM exchanges WHERE is_legacy) e
 WHERE split_part(sr.key, ':', 1) IN ('allowance', 'dividends', 'borrow-fees', 'market-open', 'season-check', 'indices', 'ambient-motion')
ON CONFLICT (key) DO NOTHING;
