-- Stored /v1 write responses, so a retried Idempotency-Key gets the original answer (API-CONTRACT.md → Idempotency).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope text NOT NULL,                 -- the user id, or 'anon' before sign-in
  idempotency_key uuid NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  request_hash text NOT NULL,          -- sha256 of method, path and canonical body
  status_code integer,                 -- null while the first request is still running
  response_body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx ON idempotency_keys(expires_at);
