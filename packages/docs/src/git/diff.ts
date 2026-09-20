import { utf8ByteLength } from "../markdown/index.ts";

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** 1-based line in the baseline (null for added lines). */
  readonly baseLine: number | null;
  /** 1-based line in the target (null for removed lines). */
  readonly targetLine: number | null;
}

export interface DiffHunk {
  readonly baseStart: number;
  readonly baseLines: number;
  readonly targetStart: number;
  readonly targetLines: number;
  readonly lines: readonly DiffLine[];
}

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses the unified diff of one file into hunks with explicit added and removed labels, so readers
 * never depend on color (document_history brief). File headers and "No newline" markers are dropped.
 */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: { header: Omit<DiffHunk, "lines">; lines: DiffLine[] } | null = null;
  let baseLine = 0;
  let targetLine = 0;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const header = hunkHeader.exec(line);
    if (header) {
      if (current) hunks.push({ ...current.header, lines: current.lines });
      const baseStart = Number(header[1]);
      const targetStart = Number(header[3]);
      current = {
        header: {
          baseStart,
          baseLines: header[2] === undefined ? 1 : Number(header[2]),
          targetStart,
          targetLines: header[4] === undefined ? 1 : Number(header[4]),
        },
        lines: [],
      };
      baseLine = baseStart;
      targetLine = targetStart;
      continue;
    }
    if (!current || line.startsWith("\\")) continue;
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") {
      current.lines.push({ kind: "added", text, baseLine: null, targetLine });
      targetLine += 1;
    } else if (marker === "-") {
      current.lines.push({ kind: "removed", text, baseLine, targetLine: null });
      baseLine += 1;
    } else if (marker === " ") {
      current.lines.push({ kind: "context", text, baseLine, targetLine });
      baseLine += 1;
      targetLine += 1;
    }
  }
  if (current) hunks.push({ ...current.header, lines: current.lines });
  return hunks;
}

/** Whether a hunk touches any of the 1-based inclusive line ranges of the target (or baseline). */
export function hunkTouches(
  hunk: DiffHunk,
  ranges: ReadonlyArray<{
    readonly side: "base" | "target";
    readonly from: number;
    readonly to: number;
  }>,
): boolean {
  return ranges.some((range) =>
    hunk.lines.some((line) => {
      const number = range.side === "base" ? line.baseLine : line.targetLine;
      return (
        line.kind !== "context" && number !== null && number >= range.from && number <= range.to
      );
    }),
  );
}

/**
 * A bounded page of diff lines: hunks from `offset` (a hunk index) until `maxBytes` of line text is
 * reached. A hunk larger than the budget is cut at a line boundary and marked truncated, and the next
 * page starts at the following hunk. At least one line is returned when any remain.
 */
export function pageDiffHunks(
  hunks: readonly DiffHunk[],
  offset: number,
  maxBytes: number,
): {
  readonly hunks: readonly (DiffHunk & { readonly truncated: boolean })[];
  readonly nextOffset: number | null;
  readonly deliveredBytes: number;
} {
  const page: Array<DiffHunk & { truncated: boolean }> = [];
  let bytes = 0;
  let index = offset;
  for (; index < hunks.length; index += 1) {
    const hunk = hunks[index] as DiffHunk;
    const lines: DiffLine[] = [];
    let truncated = false;
    for (const line of hunk.lines) {
      const size = utf8ByteLength(line.text) + 2;
      if (bytes + size > maxBytes && (page.length > 0 || lines.length > 0)) {
        truncated = true;
        break;
      }
      lines.push(line);
      bytes += size;
    }
    if (lines.length === 0) break;
    page.push({ ...hunk, lines, truncated });
    if (truncated) {
      index += 1;
      break;
    }
  }
  return { hunks: page, nextOffset: index < hunks.length ? index : null, deliveredBytes: bytes };
}
