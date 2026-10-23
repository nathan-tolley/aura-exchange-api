CREATE TABLE limit_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id),
  user_id uuid NOT NULL REFERENCES users(id),
  stock_id uuid NOT NULL REFERENCES person_stocks(id),
  side text NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity numeric(20,8) NOT NULL CHECK (quantity>0),
  limit_price numeric(20,8) NOT NULL CHECK (limit_price>0),
  reserved_cash numeric(20,8) NOT NULL DEFAULT 0 CHECK (reserved_cash>=0),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','FILLED','CANCELED')),
  filled_trade_id uuid REFERENCES trades(id),
  filled_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX limit_orders_open_idx ON limit_orders(status,created_at);
CREATE INDEX limit_orders_user_idx ON limit_orders(user_id,season_id,created_at DESC);
