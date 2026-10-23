ALTER TABLE aura_submissions DROP CONSTRAINT IF EXISTS aura_submissions_status_check;
ALTER TABLE aura_submissions ADD CONSTRAINT aura_submissions_status_check
  CHECK (status IN ('PENDING','JUDGING','APPLIED','REVIEW','FARMING','DECLINED','REJECTED','APPEALED','OVERTURNED','FAILED'));

CREATE TABLE aura_swing_polls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL UNIQUE REFERENCES aura_submissions(id),
  ruling_id uuid NOT NULL REFERENCES aura_rulings(id),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  outcome text CHECK (outcome IN ('SUPPORT','DECLINE','RECONSIDER')),
  closes_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX aura_swing_polls_close_idx ON aura_swing_polls(status,closes_at);

CREATE TABLE aura_swing_votes (
  poll_id uuid NOT NULL REFERENCES aura_swing_polls(id) ON DELETE CASCADE,
  voter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  choice text NOT NULL CHECK (choice IN ('SUPPORT','DECLINE','RECONSIDER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id,voter_id)
);
