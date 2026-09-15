import type { Heading, Root, RootContent } from "mdast";
import { containsRawHtml, type DocumentParse, parseDocument, plainTextOf } from "./parse.ts";
import { LineTable, singleLine } from "./text.ts";

/**
 * Structural sections of a task document (§9.1, note 06 "Bounds and correctness"):
 *
 * - `heading`: a top-level heading (ATX or setext) with its own body up to the next heading of any
 *   depth. Headings inside fenced code, blockquotes or lists are not sections. Duplicate headings are
 *   distinct sections. A section's descendants are separate sections, reachable through `parentPath`.
 * - `preamble`: non-blank text before the first heading.
 * - `block`: a document without headings is split into blocks of whole top-level nodes of about
 *   {@link SECTION_BLOCK_TARGET_CHARS}, never inside a node (so never inside a fence).
 *
 * Sections partition the document: their `[start, end)` ranges are contiguous and cover every UTF-16
 * code unit, so replacing one range leaves every other section byte-identical. Leading blank lines
 * belong to the first section.
 */
export type SectionKind = "preamble" | "heading" | "block";

export interface StructuralSection {
  /** `p` for the preamble, `h<n>` for the n-th heading section, `b<n>` for the n-th block. */
  readonly path: string;
  readonly kind: SectionKind;
  /** Heading depth 1–6; 0 for the preamble and blocks. */
  readonly depth: number;
  /** The heading's plain text on one line; null for the preamble and blocks. */
  readonly heading: string | null;
  /** The nearest earlier heading section with a smaller depth. */
  readonly parentPath: string | null;
  /** First UTF-16 offset of the section. */
  readonly start: number;
  /** First offset after the heading (equals `start` for the preamble and blocks). */
  readonly bodyStart: number;
  /** End of the section's own content: the next section's start, or the document length. */
  readonly end: number;
  /** End of the section together with its descendant sections. */
  readonly subtreeEnd: number;
  /** 1-based first line. */
  readonly lineStart: number;
  /** 1-based last line (inclusive). */
  readonly lineEnd: number;
}

export interface DocumentStructure {
  /** `parsed` when remark indexed the document; `fallback` when the line scanner did (§9.1 limits). */
  readonly mode: "parsed" | "fallback";
  readonly fallbackReason: string | null;
  /** Raw HTML nodes present (conservatively true in fallback mode when a tag-like `<` appears). */
  readonly hasRawHtml: boolean;
  /** Document length in UTF-16 code units. */
  readonly length: number;
  readonly sections: readonly StructuralSection[];
}

/** Target size of heading-free blocks, in UTF-16 code units. */
export const SECTION_BLOCK_TARGET_CHARS = 4_000;

interface HeadingMark {
  readonly start: number;
  readonly end: number;
  readonly depth: number;
  readonly text: string;
}

interface Draft {
  readonly path: string;
  readonly kind: SectionKind;
  readonly depth: number;
  readonly heading: string | null;
  readonly start: number;
  readonly bodyStart: number;
  readonly end: number;
}

function offsetOf(node: RootContent, which: "start" | "end"): number | null {
  const offset = node.position?.[which].offset;
  return typeof offset === "number" ? offset : null;
}

function finish(source: string, drafts: readonly Draft[]): StructuralSection[] {
  const lines = new LineTable(source);
  const sections: StructuralSection[] = [];
  const openHeadings: { depth: number; path: string }[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index] as Draft;
    let parentPath: string | null = null;
    let subtreeEnd = draft.end;
    if (draft.kind === "heading") {
      while (openHeadings.length > 0 && (openHeadings.at(-1)?.depth ?? 0) >= draft.depth) {
        openHeadings.pop();
      }
      parentPath = openHeadings.at(-1)?.path ?? null;
      openHeadings.push({ depth: draft.depth, path: draft.path });
      subtreeEnd = source.length;
      for (let next = index + 1; next < drafts.length; next += 1) {
        const candidate = drafts[next] as Draft;
        if (candidate.kind === "heading" && candidate.depth <= draft.depth) {
          subtreeEnd = candidate.start;
          break;
        }
      }
    }
    sections.push(
      Object.freeze({
        path: draft.path,
        kind: draft.kind,
        depth: draft.depth,
        heading: draft.heading,
        parentPath,
        start: draft.start,
        bodyStart: draft.bodyStart,
        end: draft.end,
        subtreeEnd,
        lineStart: lines.lineOf(draft.start),
        lineEnd: lines.lineOf(Math.max(draft.start, draft.end - 1)),
      }),
    );
  }
  return sections;
}

function headingSections(source: string, headings: readonly HeadingMark[]): Draft[] {
  const drafts: Draft[] = [];
  const first = headings[0];
  if (!first) return drafts;
  const hasPreamble = source.slice(0, first.start).trim().length > 0;
  if (hasPreamble) {
    drafts.push({
      path: "p",
      kind: "preamble",
      depth: 0,
      heading: null,
      start: 0,
      bodyStart: 0,
      end: first.start,
    });
  }
  headings.forEach((mark, index) => {
    const start = index === 0 && !hasPreamble ? 0 : mark.start;
    drafts.push({
      path: `h${index}`,
      kind: "heading",
      depth: mark.depth,
      heading: mark.text,
      start,
      bodyStart: Math.max(start, mark.end),
      end: headings[index + 1]?.start ?? source.length,
    });
  });
  return drafts;
}

function blockSections(source: string, boundaries: readonly number[], target: number): Draft[] {
  const drafts: Draft[] = [];
  let start = 0;
  for (const boundary of boundaries) {
    if (boundary > start && boundary - start >= target) {
      drafts.push(blockDraft(drafts.length, start, boundary));
      start = boundary;
    }
  }
  if (start < source.length) drafts.push(blockDraft(drafts.length, start, source.length));
  return drafts;
}

function blockDraft(index: number, start: number, end: number): Draft {
  return {
    path: `b${index}`,
    kind: "block",
    depth: 0,
    heading: null,
    start,
    bodyStart: start,
    end,
  };
}

function parsedStructure(source: string, tree: Root, target: number): Draft[] {
  const headings: HeadingMark[] = [];
  const boundaries: number[] = [];
  for (const child of tree.children) {
    const start = offsetOf(child, "start");
    const end = offsetOf(child, "end");
    if (start === null || end === null) continue;
    boundaries.push(start);
    if (child.type === "heading") {
      headings.push({
        start,
        end,
        depth: (child as Heading).depth,
        text: singleLine(plainTextOf(child)),
      });
    }
  }
  return headings.length > 0
    ? headingSections(source, headings)
    : blockSections(source, boundaries, target);
}

const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const atxPattern = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * The line scanner used when the parser's work limits are exceeded: ATX headings (0–3 spaces of
 * indentation) outside fenced code blocks. It does not detect setext headings or container context,
 * so its sections are approximate, which `mode: "fallback"` reports.
 */
function scannedStructure(source: string, target: number): Draft[] {
  const headings: HeadingMark[] = [];
  const boundaries: number[] = [];
  let fence: { readonly marker: string; readonly length: number } | null = null;
  let offset = 0;
  let previousBlank = true;
  for (const line of source.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    const fenceMatch = fencePattern.exec(text);
    if (fence) {
      const run = fenceMatch?.[1];
      if (
        run &&
        run[0] === fence.marker &&
        run.length >= fence.length &&
        (fenceMatch?.[2] ?? "").trim() === ""
      ) {
        fence = null;
      }
      previousBlank = false;
      continue;
    }
    if (fenceMatch?.[1] && !(fenceMatch[1][0] === "`" && (fenceMatch[2] ?? "").includes("`"))) {
      if (previousBlank) boundaries.push(lineStart);
      fence = { marker: fenceMatch[1][0] as string, length: fenceMatch[1].length };
      previousBlank = false;
      continue;
    }
    const blank = text.trim().length === 0;
    if (!blank && previousBlank) boundaries.push(lineStart);
    const atx = atxPattern.exec(text);
    if (atx?.[1]) {
      const content = (atx[2] ?? "").replace(/(?:^|[ \t]+)#+$/, "");
      headings.push({
        start: lineStart,
        end: lineStart + text.length,
        depth: atx[1].length,
        text: singleLine(content),
      });
      boundaries.push(lineStart);
    }
    previousBlank = blank;
  }
  return headings.length > 0
    ? headingSections(source, headings)
    : blockSections(source, boundaries, target);
}

/**
 * Splits a document into its structural sections. Parses with remark when the document is within
 * the work limits, otherwise uses the line scanner. Never throws.
 */
export function splitSections(
  source: string,
  options: { readonly blockTargetChars?: number; readonly parsed?: DocumentParse } = {},
): DocumentStructure {
  const target = options.blockTargetChars ?? SECTION_BLOCK_TARGET_CHARS;
  if (source.trim().length === 0) {
    return Object.freeze({
      mode: "parsed",
      fallbackReason: null,
      hasRawHtml: false,
      length: source.length,
      sections: Object.freeze([]),
    });
  }
  const parsed = options.parsed ?? parseDocument(source);
  if (parsed.mode === "parsed") {
    return Object.freeze({
      mode: "parsed",
      fallbackReason: null,
      hasRawHtml: containsRawHtml(parsed.tree),
      length: source.length,
      sections: Object.freeze(finish(source, parsedStructure(source, parsed.tree, target))),
    });
  }
  return Object.freeze({
    mode: "fallback",
    fallbackReason: parsed.reason,
    hasRawHtml: /<[A-Za-z!/?]/.test(source),
    length: source.length,
    sections: Object.freeze(finish(source, scannedStructure(source, target))),
  });
}

/** The section containing a UTF-16 offset, for preserving position across views (§9.3). */
export function sectionAtOffset(
  structure: DocumentStructure,
  offset: number,
): StructuralSection | null {
  for (const section of structure.sections) {
    if (offset >= section.start && offset < section.end) return section;
  }
  return structure.sections.at(-1) ?? null;
}
