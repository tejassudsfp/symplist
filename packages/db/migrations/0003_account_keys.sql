-- One wrapped account data key per account (§4.1). Deleting the row is the crypto-shred (§5.6).
CREATE TABLE account_keys (
  owner_id TEXT PRIMARY KEY NOT NULL REFERENCES users (id),
  -- The CONTENT_KEK version that wraps the key.
  kek_version INTEGER NOT NULL CHECK (kek_version >= 1),
  -- base64url AES-256-GCM ciphertext with IV and tag.
  wrapped_key TEXT NOT NULL CHECK (length(wrapped_key) > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL
) STRICT;

-- Re-wrapping finds rows still under an old KEK version.
CREATE INDEX account_keys_kek_version ON account_keys (kek_version);
