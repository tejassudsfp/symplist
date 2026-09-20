-- Durable search intents (§10.1), inserted in the same batch as the source change. The integer id
-- orders intents for search_indexes.applied_through.
CREATE TABLE search_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES users (id),
  entity TEXT NOT NULL CHECK (entity IN ('task', 'document', 'message')),
  entity_id TEXT NOT NULL,
  revision_or_seq INTEGER NOT NULL CHECK (revision_or_seq >= 0),
  op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  created_at INTEGER NOT NULL
) STRICT;

-- The index writer applies an owner's pending intents in id order.
CREATE INDEX search_intents_owner ON search_intents (owner_id, id);
-- The hourly cleanup re-enqueues owners with intents older than 5 minutes.
CREATE INDEX search_intents_created ON search_intents (created_at);
