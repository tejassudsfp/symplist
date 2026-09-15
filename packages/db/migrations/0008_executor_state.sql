-- The single executor generation shared by Simon runs, document Git tasks, indexing, account purge
-- and the reminder scanner (§8.1). Every task compares it before each step and exits when it moved.
CREATE TABLE executor_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  -- NULL until the first api start records the configured mode; changed only by executor:switch.
  mode TEXT CHECK (mode IS NULL OR mode IN ('local', 'durable')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  switched_at INTEGER,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL
) STRICT;

INSERT INTO executor_state (id, mode, generation, switched_at, updated_at, write_id)
VALUES (1, NULL, 1, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000, '00000000-0000-7000-8000-000000000000');
