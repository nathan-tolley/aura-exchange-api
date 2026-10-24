ALTER TABLE limit_orders DROP CONSTRAINT IF EXISTS limit_orders_status_check;
ALTER TABLE limit_orders ADD CONSTRAINT limit_orders_status_check
  CHECK (status IN ('OPEN','FILLED','CANCELED','EXPIRED','DELISTED','SEASON_CLOSED'));

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS ip_address inet,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

CREATE TABLE IF NOT EXISTS season_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL UNIQUE REFERENCES seasons(id),
  snapshot jsonb NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_time_idx ON notifications(user_id, created_at DESC);

INSERT INTO system_state(key,value)
VALUES ('restore_test', '{"completedAt":null}'::jsonb)
ON CONFLICT (key) DO NOTHING;
