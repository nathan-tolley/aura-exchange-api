-- /v1 invites join an exchange (person_stock_id is null; the member then picks a ticker at their IPO).
-- The /api console's claim codes keep pointing at a pre-created listing.
ALTER TABLE invites ALTER COLUMN person_stock_id DROP NOT NULL;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0);
