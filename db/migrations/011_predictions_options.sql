CREATE TABLE prediction_markets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id),
  creator_id uuid NOT NULL REFERENCES users(id),
  question text NOT NULL CHECK (char_length(question) BETWEEN 10 AND 180),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','CANCELED')),
  closes_at timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('YES','NO')),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > created_at)
);
CREATE INDEX prediction_markets_status_close_idx ON prediction_markets(status,closes_at);

CREATE TABLE prediction_bets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES prediction_markets(id),
  user_id uuid NOT NULL REFERENCES users(id),
  side text NOT NULL CHECK (side IN ('YES','NO')),
  amount numeric(20,8) NOT NULL CHECK (amount >= 10),
  payout numeric(20,8),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prediction_bets_market_idx ON prediction_bets(market_id,created_at);
CREATE INDEX prediction_bets_user_idx ON prediction_bets(user_id,created_at DESC);

CREATE TABLE option_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id),
  user_id uuid NOT NULL REFERENCES users(id),
  stock_id uuid NOT NULL REFERENCES person_stocks(id),
  option_type text NOT NULL CHECK (option_type IN ('CALL','PUT')),
  strike numeric(20,8) NOT NULL CHECK (strike > 0),
  quantity numeric(20,8) NOT NULL CHECK (quantity > 0),
  spot_price numeric(20,8) NOT NULL CHECK (spot_price > 0),
  premium_per_share numeric(20,8) NOT NULL CHECK (premium_per_share > 0),
  total_premium numeric(20,8) NOT NULL CHECK (total_premium > 0),
  expires_at timestamptz NOT NULL,
  quote_expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE aura_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL UNIQUE REFERENCES option_quotes(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  user_id uuid NOT NULL REFERENCES users(id),
  stock_id uuid NOT NULL REFERENCES person_stocks(id),
  option_type text NOT NULL CHECK (option_type IN ('CALL','PUT')),
  strike numeric(20,8) NOT NULL CHECK (strike > 0),
  quantity numeric(20,8) NOT NULL CHECK (quantity > 0),
  premium_paid numeric(20,8) NOT NULL CHECK (premium_paid > 0),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SETTLED','CANCELED')),
  settlement_price numeric(20,8),
  payout numeric(20,8),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX aura_options_open_expiry_idx ON aura_options(status,expires_at);
CREATE INDEX aura_options_user_idx ON aura_options(user_id,created_at DESC);
