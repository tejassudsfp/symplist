import { int, LocalSqliteClient, sql } from "@symplist/db";
import type { MainLog } from "./log.ts";

/**
 * The local transcript store: every conversation, every turn, and every raw ACP update, in one SQLite
 * file under the app support directory.
 *
 * It exists because the harness will not keep it. `dsh-acp` states in two places that resuming a session
 * "does not replay history", and ACP omits transcript replay on purpose, so the only way a person sees
 * yesterday's conversation is if Symplist wrote it down. What gets written is **the wire format itself**,
 * unparsed: the renderer folds these rows through the same reducer it folds live notifications through
 * (`apps/web/src/features/simon/projection.ts`), so history and the live pane cannot drift and a
 * projection bug is fixed in one place.
 *
 * And it stays here. Note 18 makes this permanent: "No conversation is ever stored in the cloud again."
 * There is no upload path, no sync, and nothing in this file knows the api exists.
 *
 * `node:sqlite`'s `DatabaseSync` was the schedule risk, so it was checked first: Electron 44.4.5 embeds
 * Node 24.21.0 and exposes it, with `PRAGMA journal_mode = WAL` working. No native rebuild step is
 * needed in the .dmg pipeline.
 */

/** The tables that may never be rewritten. */
export const transcriptAppendOnlyTables: readonly string[] = Object.freeze(["transcript_updates"]);

/**
 * The schema. Expand-only like the cloud's, for the same reason: a released app has files on disks we
 * cannot reach, so a column that exists has to keep existing.
 *
 * `transcript_updates` holds one row per ACP notification, `update_json` verbatim. It is append-only at
 * the SQLite authorizer, which means a delete is impossible through `batch()` — deliberately. Transcripts
 * are permanent, so there is no delete path in phase 2; if one is ever wanted it goes through
 * `executeScript`, the way a migration does, where the intent is unmistakable.
 */
const schema = `
CREATE TABLE IF NOT EXISTS transcript_conversations (
  id TEXT PRIMARY KEY,
  acp_session_id TEXT,
  task_id TEXT,
  cwd TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transcript_conversations_updated
  ON transcript_conversations (updated_at DESC);
CREATE INDEX IF NOT EXISTS transcript_conversations_task
  ON transcript_conversations (task_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS transcript_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES transcript_conversations (id),
  seq INTEGER NOT NULL,
  prompt_json TEXT NOT NULL,
  stop_reason TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (conversation_id, seq)
);
CREATE TABLE IF NOT EXISTS transcript_updates (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES transcript_conversations (id),
  seq INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  update_json TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS transcript_updates_read
  ON transcript_updates (conversation_id, seq DESC);
`;

export interface TranscriptConversation {
  readonly conversationId: string;
  readonly acpSessionId: string | null;
  readonly taskId: string | null;
  readonly cwd: string;
  readonly title: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoredUpdate {
  readonly seq: number;
  readonly receivedAt: number;
  /** The raw ACP `update` object, as it arrived. Never parsed here. */
  readonly update: unknown;
}

export interface TranscriptPage {
  readonly updates: readonly StoredUpdate[];
  /** The `beforeSeq` to ask for the page before this one, or null when this is the oldest. */
  readonly nextBeforeSeq: number | null;
}

export interface TranscriptStoreOptions {
  /** The SQLite file, or `:memory:` in tests. Parent directories are created. */
  readonly path: string;
  readonly log?: MainLog;
  /** Injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** How many updates one `history` page carries. */
  readonly pageSize?: number;
}

/** How many rows a history page carries. Small enough to render, large enough to be one round trip. */
const defaultPageSize = 200;

export class TranscriptStore {
  private readonly db: LocalSqliteClient;
  private readonly now: () => number;
  private readonly pageSize: number;
  private readonly log: MainLog | undefined;
  /** The next `seq` per conversation, so appends never round-trip to read `MAX(seq)`. */
  private readonly nextSeq = new Map<string, number>();
  private ready: Promise<void> | null = null;

  constructor(options: TranscriptStoreOptions) {
    this.db = new LocalSqliteClient({
      path: options.path,
      appendOnlyTables: transcriptAppendOnlyTables,
      // The client refuses to run under `NODE_ENV=production`, because in the cloud it is a development
      // stand-in for D1. Here SQLite *is* the production store, so the guard is answered explicitly
      // rather than left to whatever the packaged app happens to have in its environment.
      env: {},
    });
    this.now = options.now ?? Date.now;
    this.pageSize = options.pageSize ?? defaultPageSize;
    this.log = options.log;
  }

  /** Creates the schema. Idempotent, and awaited by every other method. */
  async open(): Promise<void> {
    this.ready ??= this.db.executeScript(schema);
    await this.ready;
  }

  /**
   * Records a conversation, or updates the one that exists.
   *
   * `cwd` is written once and then left alone: an ACP session pins a single absolute workspace and cannot
   * be given a second, so a conversation's directory is part of its identity. Passing a different one
   * would silently describe a session that never existed.
   */
  async upsertConversation(input: {
    readonly conversationId: string;
    readonly taskId: string | null;
    readonly cwd: string;
    readonly acpSessionId?: string | null;
  }): Promise<TranscriptConversation> {
    await this.open();
    const at = this.now();
    await this.db.batch([
      sql(
        `INSERT INTO transcript_conversations
           (id, acp_session_id, task_id, cwd, title, created_at, updated_at)
         VALUES (:id, :session, :task, :cwd, NULL, :at, :at2)
         ON CONFLICT (id) DO UPDATE SET
           acp_session_id = COALESCE(excluded.acp_session_id, transcript_conversations.acp_session_id),
           updated_at = excluded.updated_at`,
        {
          id: input.conversationId,
          session: input.acpSessionId ?? null,
          task: input.taskId,
          cwd: input.cwd,
          at: int(at),
          at2: int(at),
        },
      ),
    ]);
    const stored = await this.conversation(input.conversationId);
    if (!stored) throw new Error("The conversation was not stored");
    return stored;
  }

  /** Replaces the harness session id, which changes whenever a session could not be resumed. */
  async setAcpSession(conversationId: string, acpSessionId: string | null): Promise<void> {
    await this.open();
    await this.db.batch([
      sql(
        "UPDATE transcript_conversations SET acp_session_id = :session, updated_at = :at WHERE id = :id",
        { session: acpSessionId, at: int(this.now()), id: conversationId },
      ),
    ]);
  }

  /** Names a conversation. The first prompt's opening words are a reasonable title; so is nothing. */
  async setTitle(conversationId: string, title: string | null): Promise<void> {
    await this.open();
    await this.db.batch([
      sql("UPDATE transcript_conversations SET title = :title, updated_at = :at WHERE id = :id", {
        title,
        at: int(this.now()),
        id: conversationId,
      }),
    ]);
  }

  async conversation(conversationId: string): Promise<TranscriptConversation | null> {
    await this.open();
    const row = await this.db.first(
      sql(
        `SELECT id, acp_session_id, task_id, cwd, title, created_at, updated_at
         FROM transcript_conversations WHERE id = :id`,
        { id: conversationId },
      ),
    );
    return row ? toConversation(row) : null;
  }

  /** Newest first, which is the order the conversation list wants. */
  async conversations(limit = 50): Promise<readonly TranscriptConversation[]> {
    await this.open();
    const rows = await this.db.all(
      sql(
        `SELECT id, acp_session_id, task_id, cwd, title, created_at, updated_at
         FROM transcript_conversations ORDER BY updated_at DESC, id DESC LIMIT :limit`,
        { limit: int(limit) },
      ),
    );
    return rows.map(toConversation);
  }

  /** The conversation a task already has, so opening its panel does not start a second one. */
  async conversationForTask(taskId: string): Promise<TranscriptConversation | null> {
    await this.open();
    const row = await this.db.first(
      sql(
        `SELECT id, acp_session_id, task_id, cwd, title, created_at, updated_at
         FROM transcript_conversations
         WHERE task_id = :task ORDER BY updated_at DESC, id DESC LIMIT 1`,
        { task: taskId },
      ),
    );
    return row ? toConversation(row) : null;
  }

  /**
   * Appends updates and returns them with the sequence numbers they were given.
   *
   * The sequence is assigned here rather than taken from the caller, so the renderer's cursor and the
   * stored order are the same thing by construction. The first append after a restart reads `MAX(seq)`
   * once; after that the counter is in memory.
   */
  async appendUpdates(
    conversationId: string,
    updates: readonly unknown[],
  ): Promise<readonly StoredUpdate[]> {
    await this.open();
    if (!updates.length) return [];
    let seq = this.nextSeq.get(conversationId);
    if (seq === undefined) {
      const row = await this.db.first(
        sql(
          "SELECT COALESCE(MAX(seq), 0) AS highest FROM transcript_updates WHERE conversation_id = :id",
          { id: conversationId },
        ),
      );
      seq = Number(row?.highest ?? 0) + 1;
    }
    const at = this.now();
    const stored: StoredUpdate[] = [];
    const statements = updates.map((update, index) => {
      const rowSeq = (seq as number) + index;
      stored.push({ seq: rowSeq, receivedAt: at, update });
      return sql(
        `INSERT INTO transcript_updates (id, conversation_id, seq, received_at, update_json)
         VALUES (:id, :conversation, :seq, :at, :body)`,
        {
          id: `${conversationId}:${rowSeq}`,
          conversation: conversationId,
          seq: int(rowSeq),
          at: int(at),
          body: JSON.stringify(update ?? null),
        },
      );
    });
    await this.db.batch([
      ...statements,
      sql("UPDATE transcript_conversations SET updated_at = :at WHERE id = :id", {
        at: int(at),
        id: conversationId,
      }),
    ]);
    this.nextSeq.set(conversationId, seq + updates.length);
    this.log?.info("desktop.transcript.appended", {
      conversation_id: conversationId,
      count: updates.length,
    });
    return stored;
  }

  /**
   * A page of updates, oldest-first within the page, ending before `beforeSeq`.
   *
   * Reading newest-first and reversing is what makes the *newest* page the cheap one, which is the page
   * every opened conversation needs. `nextBeforeSeq` is null only when the page reached the beginning.
   */
  async history(conversationId: string, beforeSeq: number | null): Promise<TranscriptPage> {
    await this.open();
    const rows = await this.db.all(
      beforeSeq === null
        ? sql(
            `SELECT seq, received_at, update_json FROM transcript_updates
             WHERE conversation_id = :id ORDER BY seq DESC LIMIT :limit`,
            { id: conversationId, limit: int(this.pageSize) },
          )
        : sql(
            `SELECT seq, received_at, update_json FROM transcript_updates
             WHERE conversation_id = :id AND seq < :before ORDER BY seq DESC LIMIT :limit`,
            { id: conversationId, before: int(beforeSeq), limit: int(this.pageSize) },
          ),
    );
    const updates = rows
      .map((row) => ({
        seq: Number(row.seq),
        receivedAt: Number(row.received_at),
        update: parseStored(row.update_json),
      }))
      .reverse();
    const oldest = updates[0]?.seq;
    // Only a full page can have anything before it; a short one reached the beginning.
    const more = rows.length === this.pageSize && oldest !== undefined && oldest > 1;
    return { updates, nextBeforeSeq: more ? (oldest as number) : null };
  }

  /** Opens a turn and returns its id. `prompt` is stored as sent, so a replay shows what was asked. */
  async startTurn(input: {
    readonly conversationId: string;
    readonly prompt: unknown;
  }): Promise<{ readonly turnId: string; readonly seq: number }> {
    await this.open();
    const row = await this.db.first(
      sql(
        "SELECT COALESCE(MAX(seq), 0) AS highest FROM transcript_turns WHERE conversation_id = :id",
        { id: input.conversationId },
      ),
    );
    const seq = Number(row?.highest ?? 0) + 1;
    const turnId = `${input.conversationId}:turn:${seq}`;
    await this.db.batch([
      sql(
        `INSERT INTO transcript_turns
           (id, conversation_id, seq, prompt_json, stop_reason, started_at, ended_at)
         VALUES (:id, :conversation, :seq, :prompt, NULL, :at, NULL)`,
        {
          id: turnId,
          conversation: input.conversationId,
          seq: int(seq),
          prompt: JSON.stringify(input.prompt ?? null),
          at: int(this.now()),
        },
      ),
    ]);
    return { turnId, seq };
  }

  /** Closes a turn with the stop reason the harness gave, or a code when the prompt was refused. */
  async endTurn(turnId: string, stopReason: string): Promise<void> {
    await this.open();
    await this.db.batch([
      sql("UPDATE transcript_turns SET stop_reason = :reason, ended_at = :at WHERE id = :id", {
        reason: stopReason,
        at: int(this.now()),
        id: turnId,
      }),
    ]);
  }

  /** Whether a conversation has anything stored, which decides if a memory-reset divider is worth it. */
  async hasHistory(conversationId: string): Promise<boolean> {
    await this.open();
    const row = await this.db.first(
      sql("SELECT 1 AS present FROM transcript_updates WHERE conversation_id = :id LIMIT 1", {
        id: conversationId,
      }),
    );
    return row !== null && row !== undefined;
  }

  close(): void {
    this.db.close();
  }
}

function toConversation(row: Readonly<Record<string, unknown>>): TranscriptConversation {
  return {
    conversationId: String(row.id),
    acpSessionId: row.acp_session_id === null ? null : String(row.acp_session_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    cwd: String(row.cwd),
    title: row.title === null ? null : String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * A stored update, or null when the row cannot be read back as JSON.
 *
 * Null rather than a throw: one unreadable row must not make a whole conversation unopenable, and the
 * projection already ignores an update it does not recognise, so null lands exactly where it belongs.
 */
function parseStored(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
