-- Durable abuse counters (§5.8): fixed-window counts with an optional lockout for counters that
-- protect a secret and must survive restarts and deploys. Subjects are opaque ids or HMAC digests,
-- never raw email addresses or IP addresses. Expired rows are removed by the hourly cleanup.
CREATE TABLE abuse_counters (
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 64 AND scope NOT GLOB '*[^a-z0-9_.]*'),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 128),
  window_start INTEGER NOT NULL CHECK (window_start >= 0),
  count INTEGER NOT NULL CHECK (count >= 0),
  locked_until INTEGER,
  -- The later of the window end and the lockout end; rows past it carry no state.
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (scope, subject)
) STRICT;

CREATE INDEX abuse_counters_expiry ON abuse_counters (expires_at);
CREATE INDEX abuse_counters_subject ON abuse_counters (subject);
