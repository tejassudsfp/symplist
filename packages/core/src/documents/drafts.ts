import type { AccountDataKey, FieldEnvelopeContext, RandomOptions } from "@symplist/crypto";
import { decryptFieldText, encryptFieldText } from "@symplist/crypto";
import type { DbRow, Statement } from "@symplist/db";
import { int, sql } from "@symplist/db";
import { DocumentError, type SqlGuard } from "@symplist/docs";

/** The field envelope binding of `doc_drafts.draft_enc` (§4.1). */
export function draftEnvelopeContext(ownerId: string, taskId: string): FieldEnvelopeContext {
  return {
    purpose: "doc_draft",
    ownerId,
    table: "doc_drafts",
    rowId: taskId,
    column: "draft_enc",
  };
}

export interface StoredDraft {
  readonly baseRevision: string | null;
  readonly clientSeq: number;
  readonly markdown: string;
  readonly origin: "editor" | "conflict";
  readonly updatedAt: number;
}

export function selectDraftStatement(ownerId: string, taskId: string): Statement {
  return sql(
    `SELECT base_commit_id, client_seq, draft_enc, origin, updated_at FROM doc_drafts
     WHERE owner_id = :owner AND task_id = :task`,
    { owner: ownerId, task: taskId },
  );
}

/** Decrypts a draft row; a draft that fails authentication is an integrity failure without content. */
export function draftFromRow(
  row: DbRow | undefined,
  accountKey: AccountDataKey,
  ownerId: string,
  taskId: string,
): StoredDraft | null {
  if (!row) return null;
  let markdown: string;
  try {
    markdown = decryptFieldText(
      accountKey,
      draftEnvelopeContext(ownerId, taskId),
      row.draft_enc as string,
    );
  } catch {
    throw new DocumentError("document.integrity_failed");
  }
  return Object.freeze({
    baseRevision: (row.base_commit_id as string | null) ?? null,
    clientSeq: row.client_seq as number,
    markdown,
    origin: row.origin === "conflict" ? "conflict" : "editor",
    updatedAt: row.updated_at as number,
  });
}

function guardText(guards: readonly SqlGuard[]): {
  readonly text: string;
  readonly params: Record<string, string>;
} {
  const params: Record<string, string> = {};
  for (const guard of guards) Object.assign(params, guard.params);
  return { text: guards.map((guard) => `AND ${guard.sql}`).join(" "), params };
}

/**
 * The draft upsert (§9.3): written only while the guards hold (active task, admitted owner), and only
 * when it is not older than the stored draft, so an out-of-order write never replaces newer text. A
 * conflicting save preserves its candidate with origin `conflict` the same way.
 */
export function upsertDraftStatement(input: {
  readonly ownerId: string;
  readonly taskId: string;
  readonly baseRevision: string | null;
  readonly clientSeq: number;
  readonly markdown: string;
  readonly bytes: number;
  readonly origin: "editor" | "conflict";
  readonly accountKey: AccountDataKey;
  readonly now: number;
  readonly writeId: string;
  readonly guards: readonly SqlGuard[];
  readonly random?: RandomOptions;
}): Statement {
  const guards = guardText(input.guards);
  return sql(
    `INSERT INTO doc_drafts (owner_id, task_id, base_commit_id, client_seq, draft_enc, draft_bytes, origin,
       created_at, updated_at, write_id)
     SELECT :owner, :task, :base, :seq, :enc, :bytes, :origin, :now, :now, :w
     WHERE 1 = 1 ${guards.text}
     ON CONFLICT (owner_id, task_id) DO UPDATE SET
       base_commit_id = excluded.base_commit_id, client_seq = excluded.client_seq,
       draft_enc = excluded.draft_enc, draft_bytes = excluded.draft_bytes, origin = excluded.origin,
       updated_at = excluded.updated_at, write_id = excluded.write_id
     WHERE excluded.client_seq >= doc_drafts.client_seq`,
    {
      ...guards.params,
      owner: input.ownerId,
      task: input.taskId,
      base: input.baseRevision,
      seq: int(input.clientSeq),
      enc: encryptFieldText(
        input.accountKey,
        draftEnvelopeContext(input.ownerId, input.taskId),
        input.markdown,
        input.random,
      ),
      bytes: int(input.bytes),
      origin: input.origin,
      now: int(input.now),
      w: input.writeId,
    },
  );
}

/** Removes the draft when it is not newer than `clientSeq` (a save covered it). */
export function deleteDraftStatement(input: {
  readonly ownerId: string;
  readonly taskId: string;
  readonly clientSeq: number;
  readonly guards: readonly SqlGuard[];
}): Statement {
  const guards = guardText(input.guards);
  return sql(
    `DELETE FROM doc_drafts WHERE owner_id = :owner AND task_id = :task
       AND client_seq <= CAST(:seq AS INTEGER) ${guards.text}`,
    { ...guards.params, owner: input.ownerId, task: input.taskId, seq: int(input.clientSeq) },
  );
}
