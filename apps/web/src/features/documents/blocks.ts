import { parseDocument } from "@symplist/docs/markdown";
import { positionOfOffset, structureOf, type ViewPosition } from "./sections.ts";

/**
 * Top-level block boundaries, the bridge between the Markdown buffer and the page view's document.
 * A rich-text editor addresses content by top-level node index; Markdown addresses it by offset, and
 * every top-level mdast node becomes exactly one top-level node in the page view.
 */

/** UTF-16 offsets where each top-level block starts. Always begins with 0 for a non-empty document. */
export function topLevelBlockStarts(markdown: string): number[] {
  const parsed = parseDocument(markdown);
  if (parsed.mode !== "parsed") return markdown.length > 0 ? [0] : [];
  const starts: number[] = [];
  for (const child of parsed.tree.children) {
    const offset = child.position?.start.offset;
    if (typeof offset === "number") starts.push(offset);
  }
  return starts;
}

/** The index of the top-level block containing `offset`, or -1 when there are no blocks. */
export function blockIndexOfOffset(starts: readonly number[], offset: number): number {
  if (starts.length === 0) return -1;
  let index = 0;
  for (let candidate = 0; candidate < starts.length; candidate += 1) {
    if ((starts[candidate] as number) <= offset) index = candidate;
    else break;
  }
  return index;
}

/** The top-level block index a section starts at, for placing the page view's caret. */
export function blockIndexOfSection(markdown: string, sectionIndex: number): number {
  const sections = structureOf(markdown).sections;
  const section = sections[Math.max(0, Math.min(sectionIndex, sections.length - 1))];
  if (!section) return 0;
  return Math.max(0, blockIndexOfOffset(topLevelBlockStarts(markdown), section.start));
}

/** The position a top-level block index maps to: its section, and its offset inside that section. */
export function positionOfBlock(markdown: string, blockIndex: number): ViewPosition {
  const starts = topLevelBlockStarts(markdown);
  if (starts.length === 0) return { sectionIndex: 0, offsetInSection: 0 };
  const clamped = Math.max(0, Math.min(blockIndex, starts.length - 1));
  return positionOfOffset(markdown, starts[clamped] as number);
}
