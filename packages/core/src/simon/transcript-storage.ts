import type { AccountDataKey, FieldEnvelopeContext } from "@symplist/crypto";
import { decryptFieldText, encryptFieldText, zeroize } from "@symplist/crypto";
import type { DbClient, DbRow, Statement } from "@symplist/db";
import { int, sql, uuidv7 } from "@symplist/db";
import { AccountKeyStore } from "../account/keys.ts";
import { SimonError } from "./types.ts";

/**
 * D1-backed persistence for a durable chat transcript (note 07, §8.1).
 *
 * The durable runtime keeps a conversation alive across runs, and its default persistence writes the
 * whole accumulated conversation to the platform's own object storage after every turn — plaintext,
 * overwritten rather than expired, and therefore outside the account-deletion crypto-shred promise.
 * Registering a storage replaces that snapshot entirely, which is the only reason a durable chat can
 * exist here at all: the conversation stays in D1 under the account data key, and account purge
 * reaches it like every other row.
 *
 * The shape is deliberately the runtime's, not ours. Messages are addressed by the runtime's own ids
 * and ordered by first insertion; `position` is assigned once so a replacement — a settled partial,
 * an approved tool call, a compaction — keeps its place instead of jumping to the end.
 */

/** One change the runtime asks to apply. Mirrors the runtime's own union. */
export type TranscriptChange =
  | { readonly op: "put"; readonly message: { readonly id: string }; readonly final?: boolean }
  | { readonly op: "remove"; readonly id: string }
  | { readonly op: "truncateAfter"; readonly afterId: string }
  | { readonly op: "state"; readonly value: unknown };

export interface TranscriptCursors {
  readonly lastOutEventId?: string;
  readonly lastInEventId?: string;
}

export interface TranscriptChangeset {
  readonly changes: readonly TranscriptChange[];
  readonly cursors?: TranscriptCursors;
}

export interface TranscriptLoadOptions {
  readonly limit?: number;
  readonly before?: string;
}

export interface TranscriptLoadResult {
  readonly messages: readonly unknown[];
  readonly state: unknown | null;
  readonly cursors?: TranscriptCursors;
  readonly nextCursor?: string;
  readonly nonFinalIds?: readonly string[];
}

export interface TranscriptStorageOptions {
  readonly db: DbClient;
  readonly keys: ConstructorParameters<typeof AccountKeyStore>[0]["keys"];
  readonly now: () => number;
}

/** Largest transcript a single read will return, so one chat cannot exhaust a runtime. */
export const TRANSCRIPT_MAX_MESSAGES = 1_000;
/** Largest single message accepted, well inside the field envelope limit. */
export const TRANSCRIPT_MAX_MESSAGE_BYTES = 256 * 1_024;
/** Largest opaque runtime state record accepted. */
export const TRANSCRIPT_MAX_STATE_BYTES = 256 * 1_024;
/** A runtime cursor is an opaque stream offset; bound it rather than trust its length. */
const MAX_CURSOR_LENGTH = 200;

/** The envelope binding of one stored message (§4.1, §4.2). */
export function transcriptMessageContext(
  ownerId: string,
  chatId: string,
  messageId: string,
): FieldEnvelopeContext {
  return {
    purpose: "chat_transcript_message",
    ownerId,
    table: "chat_transcript_messages",
    rowId: `${chatId}:${messageId}`,
    column: "message_enc",
  };
}

/** The envelope binding of the runtime's opaque state record. */
export function transcriptStateContext(ownerId: string, chatId: string): FieldEnvelopeContext {
  return {
    purpose: "chat_transcript_state",
    ownerId,
    table: "chat_transcript_state",
    rowId: chatId,
    column: "state_enc",
  };
}

function boundedCursor(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_LENGTH)
    throw new SimonError("validation");
  return value;
}

/** JSON with a size bound. A value that will not serialize is rejected, never silently dropped. */
function encodeMessage(value: unknown, limit: number): string {
  const text = JSON.stringify(value);
  if (typeof text !== "string") throw new SimonError("validation");
  if (Buffer.byteLength(text, "utf8") > limit) throw new SimonError("validation");
  return text;
}

/**
 * The transcript of one owner's durable chats. Every statement carries the owner, so a chat id
 * learned elsewhere reads nothing: the runtime supplies the chat id from its own session and is not
 * a trust boundary.
 */
export class SimonTranscriptStorage {
  private readonly accountKeys: AccountKeyStore;

  constructor(readonly options: TranscriptStorageOptions) {
    this.accountKeys = new AccountKeyStore(options);
  }

  private async withKey<T>(ownerId: string, run: (key: AccountDataKey) => Promise<T>): Promise<T> {
    const key = await this.accountKeys.require(ownerId);
    try {
      return await run(key);
    } finally {
      zeroize(key.key);
    }
  }

  /**
   * The conversation in order, with the runtime's state and stream cursors. `before` pages backwards
   * from a message id, which is how a render reads the tail of a long chat without loading all of it.
   */
  async load(
    ownerId: string,
    chatId: string,
    options: TranscriptLoadOptions = {},
  ): Promise<TranscriptLoadResult> {
    const limit = Math.max(
      1,
      Math.min(options.limit ?? TRANSCRIPT_MAX_MESSAGES, TRANSCRIPT_MAX_MESSAGES),
    );
    const [stateResult, anchorResult] = await this.options.db.batch([
      sql(
        `SELECT state_enc, last_out_event_id, last_in_event_id FROM chat_transcript_state
         WHERE chat_id = :chat AND owner_id = :owner`,
        { chat: chatId, owner: ownerId },
      ),
      options.before === undefined
        ? sql("SELECT NULL AS position WHERE 0")
        : sql(
            `SELECT position FROM chat_transcript_messages
             WHERE chat_id = :chat AND owner_id = :owner AND message_id = :message`,
            { chat: chatId, owner: ownerId, message: options.before },
          ),
    ]);
    const stateRow = stateResult?.results[0];
    const anchor = anchorResult?.results[0];
    // An unknown `before` is not an empty conversation: it is a cursor this store never issued.
    if (options.before !== undefined && !anchor) throw new SimonError("not_found");

    const rows = await this.options.db.all(
      sql(
        `SELECT message_id, position, final, message_enc FROM chat_transcript_messages
         WHERE chat_id = :chat AND owner_id = :owner
         ${anchor ? "AND position < CAST(:before AS INTEGER)" : ""}
         ORDER BY position DESC LIMIT CAST(:limit AS INTEGER)`,
        {
          chat: chatId,
          owner: ownerId,
          limit: int(limit + 1),
          ...(anchor ? { before: int(Number(anchor.position)) } : {}),
        },
      ),
    );
    const more = rows.length > limit;
    const page = [...(more ? rows.slice(0, limit) : rows)].reverse();
    if (page.length === 0 && !stateRow) return { messages: [], state: null };

    return this.withKey(ownerId, async (key) => {
      const messages = page.map((row) =>
        JSON.parse(
          decryptFieldText(
            key,
            transcriptMessageContext(ownerId, chatId, String(row.message_id)),
            String(row.message_enc),
          ),
        ),
      );
      const nonFinalIds = page
        .filter((row) => Number(row.final) === 0)
        .map((row) => String(row.message_id));
      const cursors = {
        ...(stateRow?.last_out_event_id
          ? { lastOutEventId: String(stateRow.last_out_event_id) }
          : {}),
        ...(stateRow?.last_in_event_id ? { lastInEventId: String(stateRow.last_in_event_id) } : {}),
      };
      return {
        messages,
        state: stateRow?.state_enc
          ? JSON.parse(
              decryptFieldText(
                key,
                transcriptStateContext(ownerId, chatId),
                String(stateRow.state_enc),
              ),
            )
          : null,
        ...(Object.keys(cursors).length > 0 ? { cursors } : {}),
        ...(more && page[0] ? { nextCursor: String(page[0].message_id) } : {}),
        ...(nonFinalIds.length > 0 ? { nonFinalIds } : {}),
      };
    });
  }

  /**
   * Applies one changeset. The runtime hands the ordered changes since the last save and expects
   * them applied together, so the whole set plus the cursors goes in a single batch: a cursor that
   * lands ahead of the rows it accounts for would make a reconnecting client skip chunks stored
   * nowhere.
   */
  async save(ownerId: string, chatId: string, changeset: TranscriptChangeset): Promise<void> {
    const now = this.options.now();
    const existing = await this.options.db.all(
      sql(
        `SELECT message_id, position FROM chat_transcript_messages
         WHERE chat_id = :chat AND owner_id = :owner ORDER BY position`,
        { chat: chatId, owner: ownerId },
      ),
    );
    const positions = new Map<string, number>(
      existing.map((row) => [String(row.message_id), Number(row.position)]),
    );
    let next = existing.reduce((max, row) => Math.max(max, Number(row.position) + 1), 0);

    await this.withKey(ownerId, async (key) => {
      const statements: Statement[] = [];
      let stateChange: { value: unknown } | undefined;

      for (const change of changeset.changes) {
        switch (change.op) {
          case "put": {
            const id = change.message?.id;
            if (typeof id !== "string" || id.length === 0 || id.length > 200)
              throw new SimonError("validation");
            const known = positions.get(id);
            // A known id is replaced where it already sits; only a new id takes the next position.
            const position = known ?? next;
            if (known === undefined) {
              positions.set(id, position);
              next += 1;
            }
            const enc = encryptFieldText(
              key,
              transcriptMessageContext(ownerId, chatId, id),
              encodeMessage(change.message, TRANSCRIPT_MAX_MESSAGE_BYTES),
            );
            statements.push(
              sql(
                `INSERT INTO chat_transcript_messages
                 (chat_id, owner_id, message_id, position, final, message_enc, created_at, updated_at, write_id)
                 VALUES (:chat, :owner, :message, CAST(:position AS INTEGER), CAST(:final AS INTEGER), :enc, :now, :now, :write)
                 ON CONFLICT (chat_id, message_id) DO UPDATE SET
                   final = excluded.final, message_enc = excluded.message_enc,
                   updated_at = excluded.updated_at, write_id = excluded.write_id`,
                {
                  chat: chatId,
                  owner: ownerId,
                  message: id,
                  position: int(position),
                  final: int(change.final === false ? 0 : 1),
                  enc,
                  now: int(now),
                  write: uuidv7(now),
                },
              ),
            );
            break;
          }
          case "remove": {
            positions.delete(change.id);
            statements.push(
              sql(
                `DELETE FROM chat_transcript_messages
                 WHERE chat_id = :chat AND owner_id = :owner AND message_id = :message`,
                { chat: chatId, owner: ownerId, message: change.id },
              ),
            );
            break;
          }
          case "truncateAfter": {
            const from = positions.get(change.afterId);
            // An unknown anchor is a no-op, not a reason to drop the conversation.
            if (from === undefined) break;
            for (const [id, position] of positions) if (position > from) positions.delete(id);
            next = from + 1;
            statements.push(
              sql(
                `DELETE FROM chat_transcript_messages
                 WHERE chat_id = :chat AND owner_id = :owner AND position > CAST(:from AS INTEGER)`,
                { chat: chatId, owner: ownerId, from: int(from) },
              ),
            );
            break;
          }
          case "state":
            stateChange = { value: change.value };
            break;
        }
      }

      const stateEnc =
        stateChange === undefined || stateChange.value === null
          ? null
          : encryptFieldText(
              key,
              transcriptStateContext(ownerId, chatId),
              encodeMessage(stateChange.value, TRANSCRIPT_MAX_STATE_BYTES),
            );
      if (stateEnc !== null && Buffer.byteLength(stateEnc, "utf8") > TRANSCRIPT_MAX_STATE_BYTES * 2)
        throw new SimonError("validation");

      const out = boundedCursor(changeset.cursors?.lastOutEventId);
      const inbound = boundedCursor(changeset.cursors?.lastInEventId);
      // One upsert carries the state record, both cursors and the next position. Fields the
      // changeset did not mention keep their stored value rather than being cleared.
      statements.push(
        sql(
          `INSERT INTO chat_transcript_state
           (chat_id, owner_id, state_enc, last_out_event_id, last_in_event_id, next_position, updated_at, write_id)
           VALUES (:chat, :owner, :state, :out, :inbound, CAST(:next AS INTEGER), :now, :write)
           ON CONFLICT (chat_id) DO UPDATE SET
             state_enc = CASE WHEN CAST(:touched AS INTEGER) = 1 THEN excluded.state_enc ELSE chat_transcript_state.state_enc END,
             last_out_event_id = COALESCE(excluded.last_out_event_id, chat_transcript_state.last_out_event_id),
             last_in_event_id = COALESCE(excluded.last_in_event_id, chat_transcript_state.last_in_event_id),
             next_position = excluded.next_position,
             updated_at = excluded.updated_at, write_id = excluded.write_id`,
          {
            chat: chatId,
            owner: ownerId,
            state: stateEnc,
            out,
            inbound,
            next: int(next),
            now: int(now),
            write: uuidv7(now),
            touched: int(stateChange === undefined ? 0 : 1),
          },
        ),
      );
      await this.options.db.batch(statements);
    });
  }

  /** Every row of one owner's transcripts, for account purge (§5.6). */
  static purgeStatements(ownerId: string): readonly Statement[] {
    return [
      sql("DELETE FROM chat_transcript_messages WHERE owner_id = :owner", { owner: ownerId }),
      sql("DELETE FROM chat_transcript_state WHERE owner_id = :owner", { owner: ownerId }),
    ];
  }
}

/** Rows a caller may need for diagnostics; never the decrypted message. */
export function transcriptRowSummary(row: DbRow): { messageId: string; position: number } {
  return { messageId: String(row.message_id), position: Number(row.position) };
}
