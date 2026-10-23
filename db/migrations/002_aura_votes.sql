ALTER TABLE person_stocks
  ALTER COLUMN seasonal_aura TYPE numeric(12,2) USING seasonal_aura::numeric,
  ALTER COLUMN career_aura TYPE numeric(12,2) USING career_aura::numeric;

ALTER TABLE aura_ledger_entries
  ALTER COLUMN delta TYPE numeric(12,2) USING delta::numeric;

ALTER TABLE dividend_settlements
  ALTER COLUMN aura_delta TYPE numeric(12,2) USING aura_delta::numeric;

CREATE TABLE IF NOT EXISTS aura_votes (
  feed_event_id uuid NOT NULL REFERENCES feed_events(id) ON DELETE CASCADE,
  voter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction smallint NOT NULL CHECK (direction IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feed_event_id, voter_id)
);

CREATE INDEX IF NOT EXISTS aura_votes_event_idx ON aura_votes(feed_event_id);
