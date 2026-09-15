-- Idempotency-Key records (§6.1): an HMAC fingerprint of the validated input and the encrypted
-- response (a redacted outcome for endpoints that mint one-time secrets).
CREATE TABLE idempotency_records (
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 200),
  user_id TEXT NOT NULL REFERENCES users (id),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  fingerprint TEXT NOT NULL,
  fingerprint_version INTEGER NOT NULL CHECK (fingerprint_version >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  -- Field envelope with purpose 'idempotency_response'.
  response_enc TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (scope, user_id, key),
  CHECK (expires_at > created_at),
  CHECK (status = 'pending' OR http_status IS NOT NULL)
) STRICT;

CREATE INDEX idempotency_records_user ON idempotency_records (user_id);
CREATE INDEX idempotency_records_expiry ON idempotency_records (expires_at);
