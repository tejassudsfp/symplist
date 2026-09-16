import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { parseDocument } from "./parse.ts";

/**
 * The one canonical serializer (§9.2): `remark-stringify` with these options, used for Simon's section
 * updates and every server-side write, and by the page view to detect a non-canonical document
 * (decision R7). With GFM it is a fixed point of Milkdown 7.22.1's output (research "Markdown").
 */
export const CANONICAL_STRINGIFY_OPTIONS = Object.freeze({
  bullet: "*",
  emphasis: "*",
  strong: "_",
  rule: "-",
  fences: true,
  listItemIndent: "one",
} as const);

const serializer = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, { ...CANONICAL_STRINGIFY_OPTIONS })
  .freeze();

/** The document is beyond the parser work limits, so it cannot be re-serialized. */
export class MarkdownTooComplexError extends Error {
  readonly code = "document.too_complex";
  constructor() {
    super("The Markdown is too complex to normalize");
    this.name = "MarkdownTooComplexError";
  }
}

/**
 * Serializes Markdown canonically. Empty or blank input serializes to the empty string. Throws
 * {@link MarkdownTooComplexError} when the source exceeds the document work limits or the parser
 * fails, so a hostile document is never partially normalized.
 */
export function canonicalizeMarkdown(source: string): string {
  if (source.trim().length === 0) return "";
  const parsed = parseDocument(source);
  if (parsed.mode !== "parsed") throw new MarkdownTooComplexError();
  try {
    return String(serializer.stringify(parsed.tree));
  } catch {
    throw new MarkdownTooComplexError();
  }
}

/** Serializes an already parsed tree canonically (the tree is not modified). */
export function serializeCanonicalTree(tree: Root): string {
  if (tree.children.length === 0) return "";
  try {
    return String(serializer.stringify(tree));
  } catch {
    throw new MarkdownTooComplexError();
  }
}

/** Whether a document already equals its canonical form; false when it cannot be normalized. */
export function isCanonicalMarkdown(source: string): boolean {
  try {
    return canonicalizeMarkdown(source) === source;
  } catch {
    return false;
  }
}

/**
 * The form two versions of a section are compared in, so formatting-only differences (list markers,
 * setext versus ATX headings, table padding, emphasis markers) are content-neutral (§9.3, decision R7):
 * the canonical serialization when the section can be parsed, otherwise the text with trailing
 * whitespace removed from each line and blank-line runs collapsed.
 */
export function comparableSectionText(sectionMarkdown: string): string {
  try {
    return canonicalizeMarkdown(sectionMarkdown);
  } catch {
    return sectionMarkdown
      .split("\n")
      .map((line) => line.replace(/[ \t\r]+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
