-- Workspace (§2.1, §4.4): labels, and the tasks they are on.
--
-- A label is the owner's own word for a slice of their list — "work", "errand", "waiting on Ana" — so
-- `name_enc` is a field envelope under the account data key (purpose `label_name`), exactly as
-- `tasks.title_enc` is. The colour is not: it is one of the eight accent preset names the appearance
-- settings already use, which is not the owner's content and has to be readable to order and render a
-- list without decrypting every row.
--
-- **Uniqueness is enforced in the service, not here, and that is a consequence of the encryption.** A
-- `UNIQUE (owner_id, name_enc)` index would do nothing: envelopes use a random IV, so the same word
-- encrypts differently every time. A deterministic digest column could carry the constraint, but it
-- would need its own secret family in the inventory and rotation story for a uniqueness check on a set
-- that is a few dozen rows at most — so `LabelService` reads the owner's labels and compares decrypted
-- names instead. One query, and no new key to lose.
CREATE TABLE labels (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users (id),
  name_enc TEXT NOT NULL,
  colour TEXT NOT NULL CHECK (
    colour IN ('blue', 'violet', 'rose', 'coral', 'amber', 'green', 'teal', 'graphite')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  UNIQUE (id, owner_id)
) STRICT;

-- The owner's labels, oldest first, which is the order the manage list and the filter bar show.
CREATE INDEX labels_owner ON labels (owner_id, created_at, id);

-- Which labels a task carries. The composite foreign keys keep both sides in the same owner's data, so
-- a task can never be labelled from another account even if an id were guessed.
CREATE TABLE task_labels (
  task_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (task_id, label_id),
  FOREIGN KEY (task_id, owner_id) REFERENCES tasks (id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (label_id, owner_id) REFERENCES labels (id, owner_id) ON DELETE CASCADE
) STRICT;

-- Every task carrying a label: the filter reads this direction.
CREATE INDEX task_labels_by_label ON task_labels (owner_id, label_id, task_id);
-- Every label on a task: a task row renders its own chips from this direction.
CREATE INDEX task_labels_by_task ON task_labels (task_id, label_id);
