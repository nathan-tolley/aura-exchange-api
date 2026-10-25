-- Phase 1 engine tick (NOTES.md → Plan for Phase 1 → engine tick).

-- The price engine's state for each season's pool. A season reset starts fair value over with the pool.
-- engine_base NULL means "the price when the engine first sees the pool", so no pool-creating path has to set it.
-- The rest are the engine's dimensionless ratios (not money): float8 round-trips a JS number exactly.
ALTER TABLE market_pools
  ADD COLUMN IF NOT EXISTS engine_base numeric(20,8) CHECK (engine_base > 0),
  ADD COLUMN IF NOT EXISTS engine_hype double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS engine_vol_boost double precision NOT NULL DEFAULT 0 CHECK (engine_vol_boost >= 0),
  ADD COLUMN IF NOT EXISTS engine_drift jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS engine_quiet_seconds double precision NOT NULL DEFAULT 0 CHECK (engine_quiet_seconds >= 0),
  ADD COLUMN IF NOT EXISTS engine_quiet_bleed double precision NOT NULL DEFAULT 0 CHECK (engine_quiet_bleed <= 0),
  ADD COLUMN IF NOT EXISTS engine_ticked_at timestamptz;

-- How jumpy a person's stock is (PLAN.md → Noise). It belongs to the person, so it outlives a season.
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS personality numeric(4,2) NOT NULL DEFAULT 1.00 CHECK (personality BETWEEN 0.5 AND 2.0);

-- ENGINE: one engine tick. NEWS: a ruling's opening gap (the event pipeline). detail holds the move by force.
ALTER TABLE market_price_ticks DROP CONSTRAINT IF EXISTS market_price_ticks_cause_check;
ALTER TABLE market_price_ticks
  ADD CONSTRAINT market_price_ticks_cause_check CHECK (cause IN ('OPEN', 'TRADE', 'AMBIENT', 'ENGINE', 'NEWS'));
ALTER TABLE market_price_ticks ADD COLUMN IF NOT EXISTS detail jsonb;
-- Engine and ambient ticks are purged after 7 days; the sparse OPEN/TRADE/NEWS ticks stay.
CREATE INDEX IF NOT EXISTS market_price_ticks_purge_idx ON market_price_ticks(created_at) WHERE cause IN ('ENGINE', 'AMBIENT');

-- 1-minute and 1-hour candles, kept forever. o and c follow the earliest and latest tick time (o_at, c_at), so
-- ticks inserted out of order can't scramble them; ties keep insertion order.
CREATE TABLE IF NOT EXISTS candles_1m (
  exchange_id uuid NOT NULL REFERENCES exchanges(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  stock_id uuid NOT NULL REFERENCES listings(id),
  t timestamptz NOT NULL,
  o numeric(20,8) NOT NULL CHECK (o > 0),
  h numeric(20,8) NOT NULL CHECK (h > 0),
  l numeric(20,8) NOT NULL CHECK (l > 0),
  c numeric(20,8) NOT NULL CHECK (c > 0),
  o_at timestamptz NOT NULL,
  c_at timestamptz NOT NULL,
  PRIMARY KEY (stock_id, season_id, t)
);

CREATE TABLE IF NOT EXISTS candles_1h (LIKE candles_1m INCLUDING ALL);
ALTER TABLE candles_1h
  ADD FOREIGN KEY (exchange_id) REFERENCES exchanges(id),
  ADD FOREIGN KEY (season_id) REFERENCES seasons(id),
  ADD FOREIGN KEY (stock_id) REFERENCES listings(id);

DROP TRIGGER IF EXISTS enforce_exchange_id ON candles_1m;
CREATE TRIGGER enforce_exchange_id BEFORE INSERT OR UPDATE OF exchange_id, season_id, stock_id ON candles_1m
  FOR EACH ROW EXECUTE FUNCTION enforce_exchange_id('seasons', 'season_id', 'listings', 'stock_id');
DROP TRIGGER IF EXISTS enforce_exchange_id ON candles_1h;
CREATE TRIGGER enforce_exchange_id BEFORE INSERT OR UPDATE OF exchange_id, season_id, stock_id ON candles_1h
  FOR EACH ROW EXECUTE FUNCTION enforce_exchange_id('seasons', 'season_id', 'listings', 'stock_id');

-- Every tick lands in its minute and its hour, whoever wrote it (engine, trades, console limit fills, IPO).
-- date_bin on a fixed UTC origin, so buckets don't depend on the session's TimeZone.
CREATE OR REPLACE FUNCTION add_tick_to_candles() RETURNS trigger AS $$
BEGIN
  INSERT INTO candles_1m AS cur (exchange_id, season_id, stock_id, t, o, h, l, c, o_at, c_at)
  VALUES (NEW.exchange_id, NEW.season_id, NEW.stock_id, date_bin('1 minute', NEW.created_at, TIMESTAMPTZ '2000-01-01 00:00:00+00'),
          NEW.price, NEW.price, NEW.price, NEW.price, NEW.created_at, NEW.created_at)
  ON CONFLICT (stock_id, season_id, t) DO UPDATE SET
    o = CASE WHEN EXCLUDED.o_at < cur.o_at THEN EXCLUDED.o ELSE cur.o END,
    o_at = LEAST(cur.o_at, EXCLUDED.o_at),
    h = GREATEST(cur.h, EXCLUDED.h),
    l = LEAST(cur.l, EXCLUDED.l),
    c = CASE WHEN EXCLUDED.c_at >= cur.c_at THEN EXCLUDED.c ELSE cur.c END,
    c_at = GREATEST(cur.c_at, EXCLUDED.c_at);
  INSERT INTO candles_1h AS cur (exchange_id, season_id, stock_id, t, o, h, l, c, o_at, c_at)
  VALUES (NEW.exchange_id, NEW.season_id, NEW.stock_id, date_bin('1 hour', NEW.created_at, TIMESTAMPTZ '2000-01-01 00:00:00+00'),
          NEW.price, NEW.price, NEW.price, NEW.price, NEW.created_at, NEW.created_at)
  ON CONFLICT (stock_id, season_id, t) DO UPDATE SET
    o = CASE WHEN EXCLUDED.o_at < cur.o_at THEN EXCLUDED.o ELSE cur.o END,
    o_at = LEAST(cur.o_at, EXCLUDED.o_at),
    h = GREATEST(cur.h, EXCLUDED.h),
    l = LEAST(cur.l, EXCLUDED.l),
    c = CASE WHEN EXCLUDED.c_at >= cur.c_at THEN EXCLUDED.c ELSE cur.c END,
    c_at = GREATEST(cur.c_at, EXCLUDED.c_at);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS add_tick_to_candles ON market_price_ticks;
CREATE TRIGGER add_tick_to_candles AFTER INSERT ON market_price_ticks
  FOR EACH ROW EXECUTE FUNCTION add_tick_to_candles();

-- Backfill from the ticks so far.
INSERT INTO candles_1m (exchange_id, season_id, stock_id, t, o, h, l, c, o_at, c_at)
SELECT exchange_id, season_id, stock_id, date_bin('1 minute', created_at, TIMESTAMPTZ '2000-01-01 00:00:00+00'),
       (array_agg(price ORDER BY created_at, id))[1], MAX(price), MIN(price), (array_agg(price ORDER BY created_at DESC, id DESC))[1],
       MIN(created_at), MAX(created_at)
  FROM market_price_ticks
 GROUP BY 1, 2, 3, 4
ON CONFLICT DO NOTHING;

INSERT INTO candles_1h (exchange_id, season_id, stock_id, t, o, h, l, c, o_at, c_at)
SELECT exchange_id, season_id, stock_id, date_bin('1 hour', created_at, TIMESTAMPTZ '2000-01-01 00:00:00+00'),
       (array_agg(price ORDER BY created_at, id))[1], MAX(price), MIN(price), (array_agg(price ORDER BY created_at DESC, id DESC))[1],
       MIN(created_at), MAX(created_at)
  FROM market_price_ticks
 GROUP BY 1, 2, 3, 4
ON CONFLICT DO NOTHING;
