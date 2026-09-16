import { TASK_PREVIEW_MAX_LENGTH } from "@symplist/contracts";
import type { AccountDataKey, RandomOptions } from "@symplist/crypto";
import type { Statement } from "@symplist/db";
import { sql, uuidv7 } from "@symplist/db";
import { encryptTaskPreview } from "./sql.ts";

const invisible = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/**
 * The short preview shown in a task row (note 01): whitespace collapsed to single spaces, control and
 * format characters removed, at most `TASK_PREVIEW_MAX_LENGTH` characters ending on a word boundary
 * with an ellipsis when shortened. Empty text has no preview.
 */
export function normalizeTaskPreview(text: string): string | null {
  const flat = text.replace(invisible, " ").replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return null;
  const characters = Array.from(flat);
  if (characters.length <= TASK_PREVIEW_MAX_LENGTH) return flat;
  const cut = characters.slice(0, TASK_PREVIEW_MAX_LENGTH - 1).join("");
  const boundary = cut.lastIndexOf(" ");
  const trimmed = (boundary > TASK_PREVIEW_MAX_LENGTH / 2 ? cut.slice(0, boundary) : cut).trimEnd();
  return `${trimmed}…`;
}

export interface TaskPreviewWrite {
  /** Append these to the caller's batch after its deciding statement. */
  readonly statements: readonly Statement[];
  /** Returns the new tree version when the preview was written; the last read of the batch. */
  readonly verify: Statement;
  readonly writeId: string;
}

/**
 * Statements that set a task's encrypted preview and move the owner's tree version, for the domain
 * that derives previews from the task page (documents) to fold into its own batch. The preview
 * changes only an active task owned by `ownerId`; `guard` (for example the caller's head publication
 * write-id guard) makes it depend on the caller's deciding statement. After the batch, announce the
 * commit with `announceTaskTreeCommitted` so the api's tree cache and `tasks.changed` follow.
 */
export function taskPreviewWrite(input: {
  readonly ownerId: string;
  readonly taskId: string;
  /** Plain text; normalized with {@link normalizeTaskPreview}. */
  readonly text: string;
  readonly key: AccountDataKey;
  readonly now: number;
  readonly guard?: { readonly exists: string; readonly params: Readonly<Record<string, string>> };
  readonly random?: RandomOptions;
}): TaskPreviewWrite {
  const writeId = uuidv7(input.now);
  const preview = normalizeTaskPreview(input.text);
  const guard = input.guard ? `AND ${input.guard.exists}` : "";
  const statements = [
    sql(
      `UPDATE tasks SET preview_enc = :preview, write_id = :w
       WHERE id = :task AND owner_id = :owner AND status = 'active' ${guard}`,
      {
        ...(input.guard?.params ?? {}),
        preview:
          preview === null
            ? null
            : encryptTaskPreview(input.key, input.ownerId, input.taskId, preview, input.random),
        w: writeId,
        task: input.taskId,
        owner: input.ownerId,
      },
    ),
    sql(
      `UPDATE users SET task_tree_version = task_tree_version + 1, task_tree_write_id = :w
       WHERE id = :owner AND EXISTS (SELECT 1 FROM tasks WHERE id = :task AND write_id = :w)`,
      { w: writeId, owner: input.ownerId, task: input.taskId },
    ),
  ];
  return {
    statements,
    verify: sql(
      `SELECT task_tree_version FROM users WHERE id = :owner AND task_tree_write_id = :w`,
      {
        owner: input.ownerId,
        w: writeId,
      },
    ),
    writeId,
  };
}
