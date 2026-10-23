ALTER TABLE aura_rulings
  DROP CONSTRAINT IF EXISTS aura_rulings_delta_check;

ALTER TABLE aura_rulings
  ADD CONSTRAINT aura_rulings_delta_check CHECK (delta BETWEEN -30 AND 30);

ALTER TABLE aura_ledger_entries
  DROP CONSTRAINT IF EXISTS aura_ledger_entries_delta_check;

ALTER TABLE aura_ledger_entries
  ADD CONSTRAINT aura_ledger_entries_delta_check CHECK (delta BETWEEN -30 AND 30);
