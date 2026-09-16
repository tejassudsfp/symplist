import {
  type DocumentStructure,
  type StructuralSection,
  splitSections,
} from "@symplist/docs/markdown";

/**
 * Section arithmetic shared by the two views (§9.3). Sections partition the document, so a caret is
 * always inside exactly one of them, and "switching views preserves the section (heading index plus
 * in-section offset where exact)" reduces to a section index and an offset inside that section.
 */

export interface ViewPosition {
  /** Index into the document's structural sections; 0 for an empty document. */
  readonly sectionIndex: number;
  /** UTF-16 offset from the section's start, clamped to its length when the text changed. */
  readonly offsetInSection: number;
}

export const DOCUMENT_START: ViewPosition = { sectionIndex: 0, offsetInSection: 0 };

/** The structural sections of a buffer. Never throws: a document past the parser limits still splits. */
export function structureOf(markdown: string): DocumentStructure {
  return splitSections(markdown);
}

function sectionsOf(markdown: string): readonly StructuralSection[] {
  return structureOf(markdown).sections;
}

/** The section index and in-section offset of a UTF-16 offset in `markdown`. */
export function positionOfOffset(markdown: string, offset: number): ViewPosition {
  const sections = sectionsOf(markdown);
  if (sections.length === 0) return DOCUMENT_START;
  const clamped = Math.max(0, Math.min(offset, markdown.length));
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index] as StructuralSection;
    if (clamped < section.end || index === sections.length - 1) {
      return { sectionIndex: index, offsetInSection: Math.max(0, clamped - section.start) };
    }
  }
  return DOCUMENT_START;
}

/** The UTF-16 offset a position maps to in `markdown`, clamped when the text changed since. */
export function offsetOfPosition(markdown: string, position: ViewPosition): number {
  const sections = sectionsOf(markdown);
  if (sections.length === 0) return 0;
  const index = Math.max(0, Math.min(position.sectionIndex, sections.length - 1));
  const section = sections[index] as StructuralSection;
  const length = Math.max(0, section.end - section.start);
  return section.start + Math.max(0, Math.min(position.offsetInSection, length));
}

/** The 1-based line a position starts on, for placing the raw view's caret and scroll. */
export function lineOfPosition(markdown: string, position: ViewPosition): number {
  const offset = offsetOfPosition(markdown, position);
  let line = 1;
  for (let index = 0; index < offset && index < markdown.length; index += 1) {
    if (markdown.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/**
 * The index of the section that starts with the `blockIndex`-th top-level block. The page view knows
 * its caret as a top-level block index, and a heading always starts a section, so counting block
 * starts up to that block gives the section (§9.1 "opaque section ids … structural path").
 */
export function sectionIndexOfBlockStart(markdown: string, blockStartOffset: number): number {
  return positionOfOffset(markdown, blockStartOffset).sectionIndex;
}

/** The heading of a section index, or null for the preamble, a block, or an out-of-range index. */
export function headingOfSection(markdown: string, sectionIndex: number): string | null {
  const sections = sectionsOf(markdown);
  return sections[sectionIndex]?.heading ?? null;
}

/** The UTF-16 offset a 1-based line starts at, clamped into the document. */
export function offsetOfLine(markdown: string, line: number): number {
  if (line <= 1) return 0;
  let seen = 1;
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown.charCodeAt(index) === 10) {
      seen += 1;
      if (seen === line) return index + 1;
    }
  }
  return markdown.length;
}

/** The first section with this heading, or null. Duplicate headings resolve to the first one. */
export function sectionIndexOfHeading(markdown: string, heading: string): number | null {
  const index = sectionsOf(markdown).findIndex((section) => section.heading === heading);
  return index < 0 ? null : index;
}
