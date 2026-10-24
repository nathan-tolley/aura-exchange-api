-- Multi-tenancy (ROADMAP 0.3): many exchanges per server, one membership per user per exchange,
-- and an exchange_id on every game table. Everything that existed before becomes the "Default"
-- exchange, flagged is_legacy, which the /api web console keeps serving.

CREATE TABLE IF NOT EXISTS exchanges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 40),
  timezone text NOT NULL,
  pre_open_time time NOT NULL DEFAULT '07:00',
  open_time time NOT NULL DEFAULT '09:00',
  close_time time NOT NULL DEFAULT '22:00',
  after_close_time time NOT NULL DEFAULT '02:00',
  fee_rate numeric(8,6) NOT NULL DEFAULT 0.005 CHECK (fee_rate >= 0 AND fee_rate < 1),
  extended_fee_rate numeric(8,6) NOT NULL DEFAULT 0.015 CHECK (extended_fee_rate >= 0 AND extended_fee_rate < 1),
  min_listings_to_open integer NOT NULL DEFAULT 3 CHECK (min_listings_to_open >= 1),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_legacy boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_legacy_exchange ON exchanges(is_legacy) WHERE is_legacy;

CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id uuid NOT NULL REFERENCES exchanges(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER', 'MODERATOR', 'ADMIN')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  listing_consent_at timestamptz,
  opted_out_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exchange_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);

-- A person's stock is a listing, one per member per exchange.
ALTER TABLE person_stocks RENAME TO listings;

-- Add exchange_id everywhere. Every existing row belongs to the Default exchange, so the column is added
-- with that id as a one-off default (no row rewrite, and the immutable-row triggers don't fire), then the
-- default is dropped so new rows must say which exchange they belong to.
DO $$
DECLARE
  legacy uuid;
  game_table text;
BEGIN
  INSERT INTO exchanges(name, timezone, is_legacy) VALUES ('Default', 'America/New_York', true) RETURNING id INTO legacy;

  FOREACH game_table IN ARRAY ARRAY[
    'seasons', 'listings', 'invites', 'aura_submissions', 'aura_rulings', 'aura_ledger_entries', 'appeals',
    'market_pools', 'positions', 'trade_quotes', 'trades', 'dividend_settlements', 'index_snapshots',
    'feed_events', 'aura_votes', 'market_price_ticks', 'aura_swing_polls', 'aura_swing_votes', 'limit_orders',
    'season_results', 'prediction_markets', 'prediction_bets', 'option_quotes', 'aura_options',
    'glossary_entries', 'moderation_actions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN exchange_id uuid NOT NULL DEFAULT %L REFERENCES exchanges(id)', game_table, legacy);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN exchange_id DROP DEFAULT', game_table);
  END LOOP;

  -- Per-user and audit rows can be exchange-free; the existing ones are all the Default exchange's.
  FOREACH game_table IN ARRAY ARRAY['notifications', 'audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN exchange_id uuid REFERENCES exchanges(id)', game_table);
    EXECUTE format('UPDATE %I SET exchange_id = %L', game_table, legacy);
  END LOOP;

  -- Everyone who exists today is a member of the Default exchange. OWNER becomes ADMIN.
  INSERT INTO memberships(exchange_id, user_id, role, joined_at, listing_consent_at, opted_out_at)
  SELECT legacy, u.id,
         CASE u.role WHEN 'OWNER' THEN 'ADMIN' WHEN 'MODERATOR' THEN 'MODERATOR' ELSE 'MEMBER' END,
         COALESCE(l.claimed_at, u.created_at), l.consented_at, l.opted_out_at
    FROM users u LEFT JOIN listings l ON l.owner_user_id = u.id;
END $$;

-- Uniqueness that was global is now per exchange.
ALTER TABLE seasons DROP CONSTRAINT IF EXISTS seasons_season_number_key;
ALTER TABLE seasons ADD CONSTRAINT seasons_exchange_number_key UNIQUE (exchange_id, season_number);
DROP INDEX IF EXISTS one_active_season;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_season_per_exchange ON seasons(exchange_id) WHERE status = 'ACTIVE';

ALTER TABLE listings DROP CONSTRAINT IF EXISTS person_stocks_ticker_key;
ALTER TABLE listings ADD CONSTRAINT listings_exchange_ticker_key UNIQUE (exchange_id, ticker);
ALTER TABLE listings DROP CONSTRAINT IF EXISTS person_stocks_owner_user_id_key;
ALTER TABLE listings ADD CONSTRAINT listings_exchange_owner_key UNIQUE (exchange_id, owner_user_id);

ALTER TABLE glossary_entries DROP CONSTRAINT IF EXISTS glossary_entries_phrase_key;
ALTER TABLE glossary_entries ADD CONSTRAINT glossary_entries_exchange_phrase_key UNIQUE (exchange_id, phrase);

CREATE INDEX IF NOT EXISTS feed_events_exchange_time_idx ON feed_events(exchange_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_exchange_user_time_idx ON notifications(exchange_id, user_id, created_at DESC);

-- A row's exchange must be its parents' exchange. The trigger's arguments are (parent table, column) pairs:
-- it fills a missing exchange_id from the first parent that has one, and refuses any row whose parents
-- disagree with it or with each other. That keeps a season of one exchange from ever holding another
-- exchange's listing, trade or position.
CREATE OR REPLACE FUNCTION enforce_exchange_id() RETURNS trigger AS $$
DECLARE
  i integer := 0;
  parent_id uuid;
  parent_exchange uuid;
BEGIN
  WHILE i < TG_NARGS LOOP
    EXECUTE format('SELECT ($1).%I', TG_ARGV[i + 1]) INTO parent_id USING NEW;
    IF parent_id IS NOT NULL THEN
      EXECUTE format('SELECT exchange_id FROM %I WHERE id = $1', TG_ARGV[i]) INTO parent_exchange USING parent_id;
      IF parent_exchange IS NOT NULL THEN
        IF NEW.exchange_id IS NULL THEN
          NEW.exchange_id := parent_exchange;
        ELSIF NEW.exchange_id <> parent_exchange THEN
          RAISE EXCEPTION '%.% belongs to exchange %, not %', TG_TABLE_NAME, TG_ARGV[i + 1], parent_exchange, NEW.exchange_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    i := i + 2;
  END LOOP;
  IF NEW.exchange_id IS NULL THEN
    RAISE EXCEPTION '% needs an exchange_id', TG_TABLE_NAME USING ERRCODE = 'not_null_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  rule text[];
  rules text[][] := ARRAY[
    ARRAY['invites', 'listings', 'person_stock_id', NULL, NULL],
    ARRAY['aura_submissions', 'seasons', 'season_id', 'listings', 'subject_stock_id'],
    ARRAY['aura_rulings', 'aura_submissions', 'submission_id', NULL, NULL],
    ARRAY['aura_ledger_entries', 'seasons', 'season_id', 'listings', 'stock_id'],
    ARRAY['appeals', 'aura_submissions', 'submission_id', NULL, NULL],
    ARRAY['market_pools', 'seasons', 'season_id', 'listings', 'stock_id'],
    ARRAY['positions', 'seasons', 'season_id', 'listings', 'stock_id'],
    ARRAY['trade_quotes', 'seasons', 'season_id', 'listings', 'stock_id'],
    ARRAY['trades', 'seasons', 'season_id', 'listings', 'stock_id'],
    ARRAY['dividend_settlements', 'seasons', 'season_id', 'listings', 'stock_id'],
    ARRAY['index_snapshots', 'seasons', 'season_id', NULL, NULL],
    ARRAY['feed_events', 'seasons', 'season_id', 'listings', 'subject_stock_id'],
    ARRAY['aura_votes', 'feed_events', 'feed_event_id', NULL, NULL],
    ARRAY['market_price_ticks', 'seasons', 'season_id', 'listings', 'stock_id'],
    ARRAY['aura_swing_polls', 'aura_submissions', 'submission_id', NULL, NULL],
    ARRAY['aura_swing_votes', 'aura_swing_polls', 'poll_id', NULL, NULL],
    ARRAY['limit_orders', 'seasons', 'season_id', 'listings', 'stock_id'],
    ARRAY['season_results', 'seasons', 'season_id', NULL, NULL],
    ARRAY['prediction_markets', 'seasons', 'season_id', NULL, NULL],
    ARRAY['prediction_bets', 'prediction_markets', 'market_id', NULL, NULL],
    ARRAY['option_quotes', 'seasons', 'season_id', 'listings', 'stock_id'],
    ARRAY['aura_options', 'seasons', 'season_id', 'listings', 'stock_id']
  ];
  args text;
  watched text;
BEGIN
  FOREACH rule SLICE 1 IN ARRAY rules LOOP
    args := format('%L, %L', rule[2], rule[3]);
    watched := format('exchange_id, %I', rule[3]);
    IF rule[4] IS NOT NULL THEN
      args := args || format(', %L, %L', rule[4], rule[5]);
      watched := watched || format(', %I', rule[5]);
    END IF;
    -- Updates only pay for the check when they touch the exchange or a parent column.
    EXECUTE format('DROP TRIGGER IF EXISTS enforce_exchange_id ON %I', rule[1]);
    EXECUTE format('CREATE TRIGGER enforce_exchange_id BEFORE INSERT OR UPDATE OF %s ON %I FOR EACH ROW EXECUTE FUNCTION enforce_exchange_id(%s)', watched, rule[1], args);
  END LOOP;
END $$;
