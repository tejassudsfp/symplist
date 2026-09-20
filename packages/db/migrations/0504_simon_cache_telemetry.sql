-- Prompt-cache counters are operational telemetry only; they contain no user content or identity.
ALTER TABLE runs ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (cached_input_tokens >= 0);
ALTER TABLE runs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (cache_write_tokens >= 0);
