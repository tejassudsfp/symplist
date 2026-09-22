-- The durable chat transcript (note 07 "Execution contract", §8.1). A Trigger chat session keeps a
-- conversation alive across runs, and its default persistence writes the whole accumulated
-- UIMessage[] to the platform's own object storage after every turn — plaintext, overwritten rather
-- than expired, and outside the account-deletion crypto-shred promise. Registering a transcript
-- storage replaces that snapshot entirely, so the conversation stays in D1 under the account data
-- key like every other piece of user content.
--
-- These tables are deliberately separate from `messages` and `message_parts`: those are keyed by our
-- own uuidv7 identities, sequence numbers and run lifecycle, while a transcript is keyed by the
-- runtime's message ids and ordered by first insertion. Folding one into the other would make both
-- lie about what they are.

CREATE TABLE chat_transcript_messages (
  -- The Symplist conversation the runtime knows as its chat id.
  chat_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users (id),
  -- The runtime's own message id. Opaque to us; never a Symplist identity.
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 200),
  -- Assigned once, on first insert, in the order the runtime put them. A replacement of a known id
  -- keeps its position, so a settled partial or an approved tool call does not jump to the end.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 0 when the runtime captured a partial answer from an errored or stopped turn.
  final INTEGER NOT NULL DEFAULT 1 CHECK (final IN (0, 1)),
  -- The UIMessage as a sym1 field envelope under the account data key (§4.1, §4.2).
  message_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id),
  UNIQUE (chat_id, position),
  FOREIGN KEY (chat_id, owner_id) REFERENCES conversations (id, owner_id)
) STRICT;

-- Reading one chat in transcript order, and paging it backwards from a cursor.
CREATE INDEX chat_transcript_messages_order ON chat_transcript_messages (chat_id, position);
-- Account purge deletes by owner.
CREATE INDEX chat_transcript_messages_owner ON chat_transcript_messages (owner_id);

-- One row per chat: the runtime's opaque state record and the stream cursors a continuation resumes
-- from. The cursors are runtime-computed and never interpreted here; they are stored so a fresh run
-- replays only what it has not already seen.
CREATE TABLE chat_transcript_state (
  chat_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users (id),
  -- Encrypted: the runtime's state record carries compaction summaries derived from the messages.
  state_enc TEXT,
  last_out_event_id TEXT CHECK (last_out_event_id IS NULL OR length(last_out_event_id) <= 200),
  last_in_event_id TEXT CHECK (last_in_event_id IS NULL OR length(last_in_event_id) <= 200),
  -- The next position to assign in chat_transcript_messages, so ordering survives a delete.
  next_position INTEGER NOT NULL DEFAULT 0 CHECK (next_position >= 0),
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  FOREIGN KEY (chat_id, owner_id) REFERENCES conversations (id, owner_id)
) STRICT;

CREATE INDEX chat_transcript_state_owner ON chat_transcript_state (owner_id);
