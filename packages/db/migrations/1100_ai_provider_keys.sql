-- Bring-your-own-key model access (note 07 "Confirmed requirements", §8.6).
--
-- Model credentials used to be the deployment's: one OPENAI_API_KEY in the environment, spent on
-- behalf of everybody. That is the wrong shape for an open-source product whose hosted instance is
-- a courtesy rather than a business — the operator carried every token every user spent, and a
-- self-hoster had to hold a provider account before Simon would answer at all.
--
-- Now each account holds its own provider keys, and a run uses the key belonging to the owner it
-- runs for. There is no server-side fallback: an account without a usable key gets a clear prompt
-- to add one, never somebody else's credential.
--
-- The key is a secret of exactly the kind the account data key exists for, so it is stored as a
-- sym1 envelope like every other piece of owner content (§4.1, §4.2) and reaches plaintext only
-- inside the executor that is about to call the provider. Deleting the wrapped account key
-- crypto-shreds these along with everything else.

CREATE TABLE ai_provider_keys (
  owner_id TEXT NOT NULL REFERENCES users (id),
  -- The provider this key authenticates against. Narrow on purpose: a slug here is a code path in
  -- the agent's registry, never something a caller supplies.
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  -- The API key as a sym1 field envelope under the account data key.
  key_enc TEXT NOT NULL,
  -- No part of the key is stored in the clear, not even a last-four hint: the settings screen shows
  -- that a key is configured and when it was added, which is all it needs to say. A hint would put
  -- key material in D1 backups and query logs to save a person one glance at their provider
  -- dashboard.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Set when a live call with this key last succeeded, so the screen can distinguish "saved" from
  -- "working" without ever re-displaying the secret.
  verified_at INTEGER,
  write_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, provider)
) STRICT;

-- Account purge deletes by owner.
CREATE INDEX ai_provider_keys_owner ON ai_provider_keys (owner_id);

-- Which model answers each tier, per account. Every column is nullable and falls back to the
-- deployment's configured default, so an account that has only added a key still gets a sensible
-- Fast and Smart without choosing models it has never heard of.
--
-- Provider and model are stored together per tier rather than as one global provider, because the
-- whole point is that Fast and Smart may come from different providers: a cheap fast model from one
-- account and a stronger smart model from another.
CREATE TABLE ai_model_choices (
  owner_id TEXT PRIMARY KEY NOT NULL REFERENCES users (id),
  fast_provider TEXT CHECK (fast_provider IS NULL OR fast_provider IN ('openai', 'anthropic')),
  fast_model TEXT CHECK (fast_model IS NULL OR length(fast_model) BETWEEN 1 AND 128),
  smart_provider TEXT CHECK (smart_provider IS NULL OR smart_provider IN ('openai', 'anthropic')),
  smart_model TEXT CHECK (smart_model IS NULL OR length(smart_model) BETWEEN 1 AND 128),
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL
) STRICT;
