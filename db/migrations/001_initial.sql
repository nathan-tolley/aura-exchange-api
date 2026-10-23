CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER', 'MODERATOR', 'MEMBER')),
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS person_stocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  ticker citext NOT NULL UNIQUE CHECK (ticker::text ~ '^[A-Za-z0-9]{3,5}$'),
  avatar_path text,
  owner_user_id uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT false,
  claimed_at timestamptz,
  consented_at timestamptz,
  opted_out_at timestamptz,
  seasonal_aura integer NOT NULL DEFAULT 100,
  career_aura integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_stock_id uuid NOT NULL REFERENCES person_stocks(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_number integer NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('SCHEDULED', 'ACTIVE', 'CLOSED')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_season ON seasons(status) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS aura_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id),
  author_id uuid NOT NULL REFERENCES users(id),
  subject_stock_id uuid NOT NULL REFERENCES person_stocks(id),
  explanation text NOT NULL CHECK (char_length(explanation) BETWEEN 8 AND 800),
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'JUDGING', 'APPLIED', 'REVIEW', 'REJECTED', 'APPEALED', 'OVERTURNED', 'FAILED')),
  hidden_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aura_submission_rate_idx ON aura_submissions(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS aura_submission_subject_idx ON aura_submissions(subject_stock_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS aura_recent_duplicate_idx ON aura_submissions(author_id, subject_stock_id, content_hash, season_id);

CREATE TABLE IF NOT EXISTS aura_rulings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES aura_submissions(id),
  verdict text NOT NULL CHECK (verdict IN ('GAIN', 'LOSS', 'NEUTRAL', 'REVIEW')),
  delta integer NOT NULL CHECK (delta BETWEEN -10 AND 10),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 280),
  category text NOT NULL,
  policy_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider text NOT NULL,
  model text NOT NULL,
  provider_request_id text,
  requires_review boolean NOT NULL DEFAULT false,
  is_current boolean NOT NULL DEFAULT true,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_ruling ON aura_rulings(submission_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS aura_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id),
  stock_id uuid NOT NULL REFERENCES person_stocks(id),
  submission_id uuid REFERENCES aura_submissions(id),
  ruling_id uuid REFERENCES aura_rulings(id),
  reversal_of uuid UNIQUE REFERENCES aura_ledger_entries(id),
  delta integer NOT NULL CHECK (delta BETWEEN -25 AND 25),
  reason text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aura_ledger_stock_idx ON aura_ledger_entries(stock_id, season_id, created_at);

CREATE TABLE IF NOT EXISTS appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES aura_submissions(id),
  appellant_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 800),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'UPHELD', 'OVERTURNED')),
  resolved_by uuid REFERENCES users(id),
  resolution_note text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(submission_id, appellant_id)
);

CREATE TABLE IF NOT EXISTS market_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id),
  stock_id uuid NOT NULL REFERENCES person_stocks(id),
  share_reserve numeric(20,8) NOT NULL DEFAULT 1000 CHECK (share_reserve > 0),
  credit_reserve numeric(20,8) NOT NULL DEFAULT 100000 CHECK (credit_reserve > 0),
  opening_price numeric(20,8) NOT NULL DEFAULT 100,
  day_open_price numeric(20,8) NOT NULL DEFAULT 100,
  halted_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(season_id, stock_id)
);

CREATE TABLE IF NOT EXISTS positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id),
  user_id uuid NOT NULL REFERENCES users(id),
  stock_id uuid NOT NULL REFERENCES person_stocks(id),
  long_qty numeric(20,8) NOT NULL DEFAULT 0 CHECK (long_qty >= 0),
  avg_long_cost numeric(20,8) NOT NULL DEFAULT 0 CHECK (avg_long_cost >= 0),
  short_qty numeric(20,8) NOT NULL DEFAULT 0 CHECK (short_qty >= 0),
  avg_short_entry numeric(20,8) NOT NULL DEFAULT 0 CHECK (avg_short_entry >= 0),
  short_proceeds numeric(20,8) NOT NULL DEFAULT 0 CHECK (short_proceeds >= 0),
  short_collateral numeric(20,8) NOT NULL DEFAULT 0 CHECK (short_collateral >= 0),
  realized_pnl numeric(20,8) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(season_id, user_id, stock_id),
  CHECK (NOT (long_qty > 0 AND short_qty > 0))
);

CREATE TABLE IF NOT EXISTS trade_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id),
  user_id uuid NOT NULL REFERENCES users(id),
  stock_id uuid NOT NULL REFERENCES person_stocks(id),
  side text NOT NULL CHECK (side IN ('BUY', 'SELL', 'SHORT', 'COVER')),
  quantity numeric(20,8) NOT NULL CHECK (quantity > 0),
  gross_amount numeric(20,8) NOT NULL,
  fee_amount numeric(20,8) NOT NULL,
  net_amount numeric(20,8) NOT NULL,
  execution_price numeric(20,8) NOT NULL,
  price_impact numeric(12,8) NOT NULL,
  reserve_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id),
  user_id uuid NOT NULL REFERENCES users(id),
  stock_id uuid NOT NULL REFERENCES person_stocks(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES trade_quotes(id),
  idempotency_key text NOT NULL,
  side text NOT NULL CHECK (side IN ('BUY', 'SELL', 'SHORT', 'COVER', 'LIQUIDATE')),
  quantity numeric(20,8) NOT NULL CHECK (quantity > 0),
  gross_amount numeric(20,8) NOT NULL,
  fee_amount numeric(20,8) NOT NULL,
  execution_price numeric(20,8) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS trades_stock_idx ON trades(stock_id, season_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  reference_id uuid,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  account_key text NOT NULL,
  amount numeric(20,8) NOT NULL CHECK (amount <> 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cash_ledger_account_idx ON cash_ledger_entries(account_key, created_at);

CREATE TABLE IF NOT EXISTS dividend_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id),
  stock_id uuid NOT NULL REFERENCES person_stocks(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  aura_delta integer NOT NULL,
  amount_per_share numeric(20,8) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(season_id, stock_id, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS index_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id),
  aura_composite numeric(12,4) NOT NULL,
  market_index numeric(12,4) NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS index_snapshots_time_idx ON index_snapshots(season_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS feed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid REFERENCES seasons(id),
  kind text NOT NULL,
  actor_id uuid REFERENCES users(id),
  subject_stock_id uuid REFERENCES person_stocks(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  hidden_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_events_time_idx ON feed_events(created_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, run_after, created_at);

CREATE TABLE IF NOT EXISTS scheduled_runs (
  key text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS glossary_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phrase citext NOT NULL UNIQUE,
  explanation text NOT NULL CHECK (char_length(explanation) BETWEEN 1 AND 280),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moderator_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_time_idx ON audit_logs(created_at DESC);

CREATE OR REPLACE FUNCTION reject_immutable_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable table % cannot be changed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS immutable_trade_rows ON trades;
CREATE TRIGGER immutable_trade_rows BEFORE UPDATE OR DELETE ON trades
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

DROP TRIGGER IF EXISTS immutable_cash_ledger ON cash_ledger_entries;
CREATE TRIGGER immutable_cash_ledger BEFORE UPDATE OR DELETE ON cash_ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

DROP TRIGGER IF EXISTS immutable_aura_ledger ON aura_ledger_entries;
CREATE TRIGGER immutable_aura_ledger BEFORE UPDATE OR DELETE ON aura_ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

