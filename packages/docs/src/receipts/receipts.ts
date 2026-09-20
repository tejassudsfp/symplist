import type { DbRow, Statement } from "@symplist/db";
import { int, sql, uuidv7 } from "@symplist/db";
import { compareSectionIndexes } from "../sections/changes.ts";
import type { IndexedSection, SectionIndex } from "../sections/section-index.ts";

/** Readers with receipts (§9.4): a Simon conversation or an MCP grant. */
export type ReaderKind = "conversation" | "mcp_grant";

export interface Reader {
  readonly kind: ReaderKind;
  readonly id: string;
}

/** A delivered read, ready to be written with the checkpoint that persists the tool result (§9.4). */
export interface ReceiptDraft {
  readonly ownerId: string;
  readonly taskId: string;
  readonly reader: Reader;
  readonly sectionId: string;
  readonly commitId: string;
  /** Delivered range within the section, in UTF-16 code units. */
  readonly rangeStart: number;
  readonly rangeEnd: number;
  /** The section's length at that commit, so a full read is recognizable. */
  readonly sectionLength: number;
  readonly contextEpoch: number;
  readonly runId: string | null;
  readonly deliveredBytes: number;
}

export interface ReceiptRecord {
  readonly sectionId: string;
  readonly commitId: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly sectionLength: number;
  readonly contextEpoch: number;
  readonly createdAt: number;
}

/**
 * The receipt insert. It is idempotent by the receipt key, and requires the commit to be a published
 * commit of the owner's task, so a receipt can never name another task's revision. `guard` lets the
 * caller make it conditional on its checkpoint (for example the step's write id).
 */
export function receiptStatement(
  draft: ReceiptDraft,
  now: number,
  guard?: { readonly sql: string; readonly params: Readonly<Record<string, string>> },
): Statement {
  return sql(
    `INSERT INTO read_receipts (id, owner_id, task_id, reader_kind, reader_id, section_id, commit_id,
       range_start, range_end, section_length, context_epoch, run_id, delivered_bytes, created_at)
     SELECT :id, :owner, :task, :reader_kind, :reader_id, :section, :commit, :range_start, :range_end,
       :section_length, :epoch, :run, :bytes, :now
     WHERE EXISTS (SELECT 1 FROM doc_commits WHERE task_id = :task AND owner_id = :owner AND commit_id = :commit)
       ${guard ? `AND ${guard.sql}` : ""}
     ON CONFLICT (task_id, reader_kind, reader_id, section_id, commit_id, range_start, range_end, context_epoch)
     DO NOTHING`,
    {
      ...(guard?.params ?? {}),
      id: uuidv7(now),
      owner: draft.ownerId,
      task: draft.taskId,
      reader_kind: draft.reader.kind,
      reader_id: draft.reader.id,
      section: draft.sectionId,
      commit: draft.commitId,
      range_start: int(draft.rangeStart),
      range_end: int(draft.rangeEnd),
      section_length: int(draft.sectionLength),
      epoch: int(draft.contextEpoch),
      run: draft.runId,
      bytes: int(draft.deliveredBytes),
      now: int(now),
    },
  );
}

/** A reader's most recent receipts for a task, newest first, bounded. */
export function selectReceiptsStatement(
  ownerId: string,
  taskId: string,
  reader: Reader,
  limit: number,
): Statement {
  return sql(
    `SELECT section_id, commit_id, range_start, range_end, section_length, context_epoch, created_at
     FROM read_receipts
     WHERE task_id = :task AND owner_id = :owner AND reader_kind = :kind AND reader_id = :reader
     ORDER BY created_at DESC, id DESC LIMIT CAST(:limit AS INTEGER)`,
    { task: taskId, owner: ownerId, kind: reader.kind, reader: reader.id, limit: int(limit) },
  );
}

export function receiptFromRow(row: DbRow): ReceiptRecord {
  return Object.freeze({
    sectionId: row.section_id as string,
    commitId: row.commit_id as string,
    rangeStart: row.range_start as number,
    rangeEnd: row.range_end as number,
    sectionLength: row.section_length as number,
    contextEpoch: row.context_epoch as number,
    createdAt: row.created_at as number,
  });
}

/**
 * How much of a section the reader knows (§9.4, note 11 "Simon's read position"):
 *
 * - `read`: fully delivered in the current context, and unchanged since;
 * - `partially_read`: only part of it was delivered in the current context (a truncated read);
 * - `changed_since_read`: delivered in the current context at an earlier revision, and changed since;
 * - `previously_read`: delivered only in an earlier context epoch (history compaction or a new run
 *   without the results), so it is not in context;
 * - `unread`: never delivered.
 */
export type SectionReadState =
  | "read"
  | "partially_read"
  | "changed_since_read"
  | "previously_read"
  | "unread";

export interface SectionReadPosition {
  readonly sectionId: string;
  readonly heading: string | null;
  readonly kind: IndexedSection["kind"];
  readonly depth: number;
  readonly state: SectionReadState;
  /** The latest revision the reader received any of this section at, or null. */
  readRevision: string | null;
}

export interface RemovedReadSection {
  readonly heading: string | null;
  readonly kind: IndexedSection["kind"];
  readonly readRevision: string;
}

function coversWhole(
  ranges: ReadonlyArray<{ start: number; end: number }>,
  length: number,
): boolean {
  if (length === 0) return ranges.length > 0;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let reached = 0;
  for (const range of sorted) {
    if (range.start > reached) return false;
    reached = Math.max(reached, range.end);
    if (reached >= length) return true;
  }
  return reached >= length;
}

/**
 * Read positions of every head section for a reader, from its receipts and the section indexes of the
 * revisions those receipts name (`indexes`, keyed by commit id; receipts at revisions missing from it
 * are ignored, which only ever reports less as known). Sections read in the current context at an
 * earlier revision that no longer exist are listed as removed.
 */
export function computeReadPositions(input: {
  readonly head: SectionIndex;
  readonly receipts: readonly ReceiptRecord[];
  readonly indexes: ReadonlyMap<string, SectionIndex>;
  readonly contextEpoch: number;
}): {
  readonly sections: readonly SectionReadPosition[];
  readonly removed: readonly RemovedReadSection[];
} {
  const { head, contextEpoch } = input;
  const positions = new Map<string, SectionReadPosition>(
    head.sections.map((section) => [
      section.id,
      {
        sectionId: section.id,
        heading: section.heading,
        kind: section.kind,
        depth: section.depth,
        state: "unread",
        readRevision: null,
      },
    ]),
  );
  const byCommit = new Map<string, ReceiptRecord[]>();
  for (const receipt of input.receipts) {
    const list = byCommit.get(receipt.commitId) ?? [];
    list.push(receipt);
    byCommit.set(receipt.commitId, list);
  }
  const rank: Record<SectionReadState, number> = {
    unread: 0,
    previously_read: 1,
    changed_since_read: 2,
    partially_read: 3,
    read: 4,
  };
  const removed: RemovedReadSection[] = [];

  for (const [commitId, receipts] of byCommit) {
    const index = commitId === head.commitId ? head : input.indexes.get(commitId);
    if (!index) continue;
    const pairing = commitId === head.commitId ? null : compareSectionIndexes(index, head);
    const toHead = new Map<string, string>();
    if (pairing) for (const [headId, oldId] of pairing.pairs) toHead.set(oldId, headId);
    const current = new Map<string, Array<{ start: number; end: number }>>();
    const older = new Set<string>();
    for (const receipt of receipts) {
      if (receipt.contextEpoch === contextEpoch) {
        const list = current.get(receipt.sectionId) ?? [];
        list.push({ start: receipt.rangeStart, end: receipt.rangeEnd });
        current.set(receipt.sectionId, list);
      } else if (receipt.contextEpoch < contextEpoch) {
        older.add(receipt.sectionId);
      }
    }
    const oldSections = new Map(index.sections.map((section) => [section.id, section]));
    const consider = (sectionId: string, state: SectionReadState) => {
      const headId = commitId === head.commitId ? sectionId : toHead.get(sectionId);
      const position = headId ? positions.get(headId) : undefined;
      if (!position) return false;
      if (rank[state] > rank[position.state]) {
        positions.set(position.sectionId, { ...position, state, readRevision: commitId });
      } else if (rank[state] === rank[position.state] && position.readRevision === null) {
        positions.set(position.sectionId, { ...position, readRevision: commitId });
      }
      return true;
    };
    for (const [sectionId, ranges] of current) {
      const section = oldSections.get(sectionId);
      if (!section) continue;
      const whole = coversWhole(ranges, section.end - section.start);
      let state: SectionReadState;
      if (commitId === head.commitId) {
        state = whole ? "read" : "partially_read";
      } else {
        const headId = toHead.get(sectionId);
        const headSection = headId
          ? head.sections.find((candidate) => candidate.id === headId)
          : undefined;
        if (!headSection) {
          removed.push({ heading: section.heading, kind: section.kind, readRevision: commitId });
          continue;
        }
        state =
          headSection.digest !== section.digest
            ? "changed_since_read"
            : whole
              ? "read"
              : "partially_read";
      }
      consider(sectionId, state);
    }
    for (const sectionId of older) {
      if (current.has(sectionId)) continue;
      if (!oldSections.has(sectionId)) continue;
      consider(sectionId, "previously_read");
    }
  }
  return { sections: [...positions.values()], removed };
}
