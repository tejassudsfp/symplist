-- Agent read receipts (§9.4): the section range a reader actually received at an exact commit,
-- written in the same batch as the checkpoint that persisted the tool result (Simon) or with the MCP
-- response. Readers are Simon conversations and MCP grants; `context_epoch` increments when a
-- conversation's context no longer holds earlier tool results, so older receipts count as
-- "previously read", never as known.
CREATE TABLE read_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users (id),
  task_id TEXT NOT NULL,
  reader_kind TEXT NOT NULL CHECK (reader_kind IN ('conversation', 'mcp_grant')),
  reader_id TEXT NOT NULL CHECK (length(reader_id) BETWEEN 1 AND 64),
  section_id TEXT NOT NULL CHECK (length(section_id) = 26 AND section_id GLOB 's*'),
  commit_id TEXT NOT NULL CHECK (length(commit_id) = 40 AND commit_id NOT GLOB '*[^0-9a-f]*'),
  -- The delivered range within the section, in UTF-16 code units, and the section's length.
  range_start INTEGER NOT NULL CHECK (range_start >= 0),
  range_end INTEGER NOT NULL CHECK (range_end >= range_start),
  section_length INTEGER NOT NULL CHECK (section_length >= range_end),
  context_epoch INTEGER NOT NULL CHECK (context_epoch >= 0),
  run_id TEXT,
  delivered_bytes INTEGER NOT NULL CHECK (delivered_bytes >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (task_id, reader_kind, reader_id, section_id, commit_id, range_start, range_end, context_epoch),
  FOREIGN KEY (task_id, commit_id) REFERENCES doc_commits (task_id, commit_id)
) STRICT;

-- Read positions load a reader's receipts for a task; purge deletes by owner; cleanup by age.
CREATE INDEX read_receipts_reader ON read_receipts (task_id, reader_kind, reader_id, context_epoch);
CREATE INDEX read_receipts_owner ON read_receipts (owner_id);
CREATE INDEX read_receipts_created ON read_receipts (created_at);
