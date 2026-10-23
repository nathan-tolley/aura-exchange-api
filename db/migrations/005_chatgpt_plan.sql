CREATE TABLE IF NOT EXISTS chatgpt_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  subject text NOT NULL,
  client_id text NOT NULL UNIQUE,
  scopes jsonb NOT NULL,
  encrypted_credentials text NOT NULL,
  selected_model text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chatgpt_oauth_attempts (
  state text PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chatgpt_oauth_attempts_expiry_idx ON chatgpt_oauth_attempts(expires_at);
