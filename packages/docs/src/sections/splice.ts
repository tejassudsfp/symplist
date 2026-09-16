import { canonicalizeMarkdown } from "../markdown/index.ts";
import { findSection, type SectionIndex } from "./section-index.ts";

export type SectionPlacement = "replace" | "after" | "end";

/** The section a splice names does not exist in the index it was resolved against. */
export class SectionNotFoundError extends Error {
  readonly code = "not_found";
  constructor() {
    super("Not found");
    this.name = "SectionNotFoundError";
  }
}

export interface SpliceInput {
  readonly placement: SectionPlacement;
  /** Required for `replace` and `after`. */
  readonly sectionId?: string | null;
  /** Replacement or inserted Markdown; serialized canonically before it is spliced (§9.2). */
  readonly markdown: string;
}

/**
 * Applies a section edit by offsets, so every other section stays byte-identical (§9.1, note 06):
 *
 * - `replace` swaps the section's own content (its heading line through the next heading of any
 *   depth), leaving descendant sections untouched;
 * - `after` inserts after the section's subtree;
 * - `end` appends to the document.
 *
 * The new Markdown is canonicalized, and a blank line is kept on both sides of it so it can neither
 * merge into the preceding block nor turn the following line into a setext heading. An empty
 * replacement removes the section's own content.
 */
export function spliceSection(markdown: string, index: SectionIndex, input: SpliceInput): string {
  const content = canonicalizeMarkdown(input.markdown).replace(/\n+$/, "");
  let start: number;
  let end: number;
  if (input.placement === "end") {
    start = markdown.length;
    end = markdown.length;
  } else {
    const section = input.sectionId ? findSection(index, input.sectionId) : undefined;
    if (!section) throw new SectionNotFoundError();
    start = input.placement === "replace" ? section.start : section.subtreeEnd;
    end = input.placement === "replace" ? section.end : section.subtreeEnd;
  }
  const before = markdown.slice(0, start);
  const after = markdown.slice(end);
  if (content.length === 0) {
    if (input.placement !== "replace") return markdown;
    return `${before}${after}`;
  }
  let prefix = "";
  if (before.length > 0 && !before.endsWith("\n\n")) prefix = before.endsWith("\n") ? "\n" : "\n\n";
  const suffix = after.length > 0 ? "\n\n" : "\n";
  return `${before}${prefix}${content}${suffix}${after}`;
}
