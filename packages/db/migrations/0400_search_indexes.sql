-- Published search indexes (§10.1). The index itself is an encrypted object at object_key
-- (u/<ownerId>/search/<generation>-<writeId>.idx); D1 keeps only operational references: the
-- generation, the last search intent folded into it, the format and tokenizer identity, whether chat
-- messages were included, whether a size limit cut content, and the plaintext size. The single
-- writer per mode creates the row at generation 1 and advances it with a generation compare-and-set.
CREATE TABLE search_indexes (
  owner_id TEXT PRIMARY KEY NOT NULL REFERENCES users (id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  applied_through INTEGER NOT NULL CHECK (applied_through >= 0),
  index_format_version INTEGER NOT NULL CHECK (index_format_version >= 1),
  tokenizer_fingerprint TEXT NOT NULL CHECK (length(tokenizer_fingerprint) BETWEEN 1 AND 256),
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
  include_chat INTEGER NOT NULL DEFAULT 0 CHECK (include_chat IN (0, 1)),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  byte_size INTEGER NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  -- The executor generation the publishing writer ran under (§8.1).
  executor_generation INTEGER NOT NULL CHECK (executor_generation >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL
) STRICT;
