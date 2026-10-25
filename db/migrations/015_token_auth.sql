-- Token auth for /v1 (ROADMAP 0.4): sign-in with an emailed one-time code, short-lived access tokens and
-- rotating refresh tokens. The /api console keeps its usernames, passwords and cookie sessions.

-- App users sign in by email and may have no username or password; console users may have no email yet.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email citext UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text
  CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 60);
ALTER TABLE users ALTER COLUMN username DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_identity_check;
ALTER TABLE users ADD CONSTRAINT users_identity_check CHECK (username IS NOT NULL OR email IS NOT NULL);

UPDATE users u
   SET display_name = COALESCE(
         (SELECT l.display_name FROM listings l JOIN exchanges e ON e.id = l.exchange_id AND e.is_legacy
           WHERE l.owner_user_id = u.id),
         u.username::text)
 WHERE u.display_name IS NULL;

-- One row per code sent. Only a keyed hash of the code is stored; a code lives 10 minutes and allows 5 tries.
CREATE TABLE IF NOT EXISTS login_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_codes_email_time_idx ON login_codes(email, created_at DESC);

-- Refresh tokens rotate on every use. All tokens descended from one sign-in share a family; presenting a token
-- that was already used revokes the whole family (someone else has a copy).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  parent_id uuid REFERENCES refresh_tokens(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('LOGOUT', 'REUSE')),
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens(user_id);
