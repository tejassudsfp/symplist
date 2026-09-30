import type { LabelColour, LabelView } from "@symplist/contracts";
import { appearanceAccentPresets, LABEL_NAME_MAX_LENGTH } from "@symplist/contracts";
import type { AccountDataKey, FieldEnvelopeContext, RandomOptions } from "@symplist/crypto";
import { decryptFieldText, encryptFieldText } from "@symplist/crypto";
import type { DbRow } from "@symplist/db";

/**
 * Labels: the owner's own words for slices of their list, and the rows that hold them.
 *
 * The name is the owner's content and is a field envelope under the account data key, bound the same
 * way `tasks.title_enc` is — owner, table, row, column — so a label row lifted into another account or
 * another column cannot be decrypted. The colour is not content: it is one of the eight accent preset
 * names, stored in the clear so a label list can be ordered and rendered without unwrapping a key.
 */

/** Field envelope purpose of `labels.name_enc`. */
export const LABEL_NAME_PURPOSE = "label_name";

/** The envelope binding of a label name: owner, table `labels`, the label id and column `name_enc`. */
export function labelNameContext(ownerId: string, labelId: string): FieldEnvelopeContext {
  return Object.freeze({
    purpose: LABEL_NAME_PURPOSE,
    ownerId,
    table: "labels",
    rowId: labelId,
    column: "name_enc",
  });
}

export function encryptLabelName(
  key: AccountDataKey,
  ownerId: string,
  labelId: string,
  name: string,
  random?: RandomOptions,
): string {
  return encryptFieldText(key, labelNameContext(ownerId, labelId), name, random);
}

/** Every `labels` column a service reads, in a fixed order. */
export const LABEL_COLUMNS = "id, owner_id, name_enc, colour, created_at, updated_at";

/** A row read from D1 did not have the shape the schema guarantees. */
export class LabelRowError extends Error {
  readonly code = "labels.row_invalid";
  constructor(column: string) {
    super(`Unexpected value in labels.${column}`);
    this.name = "LabelRowError";
  }
}

function text(row: DbRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new LabelRowError(column);
  return value;
}

function integer(row: DbRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new LabelRowError(column);
  }
  return value;
}

/** One label as the service holds it: the decrypted name, and no task count yet. */
export interface LabelRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly colour: LabelColour;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function isLabelColour(value: string): value is LabelColour {
  return (appearanceAccentPresets as readonly string[]).includes(value);
}

/** Decrypts one `labels` row read with {@link LABEL_COLUMNS}. */
export function labelRecordFromRow(row: DbRow, key: AccountDataKey): LabelRecord {
  const id = text(row, "id");
  const ownerId = text(row, "owner_id");
  const colour = text(row, "colour");
  if (!isLabelColour(colour)) throw new LabelRowError("colour");
  const name = decryptFieldText(key, labelNameContext(ownerId, id), text(row, "name_enc"));
  // The column is `CHECK`-free on length, so a name longer than the contract allows would reach a
  // response. Truncating rather than throwing: a too-long label is a display problem, and refusing to
  // read the row would make the whole list unopenable.
  return Object.freeze({
    id,
    ownerId,
    name: name.slice(0, LABEL_NAME_MAX_LENGTH),
    colour,
    createdAt: integer(row, "created_at"),
    updatedAt: integer(row, "updated_at"),
  });
}

/** A label as a response carries it, with how many active tasks reference it. */
export function labelView(record: LabelRecord, taskCount: number): LabelView {
  return Object.freeze({
    id: record.id,
    name: record.name,
    colour: record.colour,
    taskCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

/**
 * Whether two label names are the same label to the person who typed them.
 *
 * Case-insensitive and accent-preserving: "Work" and "work" are one label, "cafe" and "café" are two.
 * `localeCompare` with sensitivity `accent` is what draws that line, and it is the same line the
 * uniqueness check in `LabelService` applies — so a rename cannot produce a pair the create path would
 * have refused.
 */
export function sameLabelName(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

/**
 * The owner's labels as a response carries them, each with how many active tasks reference it.
 *
 * Counted from the state's own pairs rather than with a `COUNT(*)` per label: the pairs are already in
 * memory from the tree read, and a query per label would be one D1 round trip per label.
 */
export function labelViewsOf(
  labels: readonly LabelRecord[],
  taskLabels: ReadonlyMap<string, readonly string[]>,
  /**
   * Counts only these tasks, and drops a label that none of them carries. Used by a connected agent
   * whose grant covers particular tasks: it may see the labels already on them, not the whole of the
   * person's vocabulary. `null` is every task.
   */
  onlyTaskIds?: readonly string[] | null,
): LabelView[] {
  const counts = new Map<string, number>();
  const scope = onlyTaskIds == null ? null : new Set(onlyTaskIds);
  for (const [taskId, ids] of taskLabels) {
    if (scope && !scope.has(taskId)) continue;
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const views = labels.map((label) => labelView(label, counts.get(label.id) ?? 0));
  return scope ? views.filter((label) => label.taskCount > 0) : views;
}
