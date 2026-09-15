/**
 * Browser-safe Markdown helpers (§9.3, §10.4): parser work limits, section parsing, the canonical
 * serializer and link destination rules. Nothing reachable from this entry point may import `node:*`
 * or a server-only package; `packages/testing/src/browser-safe.test.ts` enforces it.
 */
export {
  CANONICAL_STRINGIFY_OPTIONS,
  canonicalizeMarkdown,
  comparableSectionText,
  isCanonicalMarkdown,
  MarkdownTooComplexError,
  serializeCanonicalTree,
} from "./canonical.ts";
export { type SafeDestination, safeDestination } from "./destinations.ts";
export {
  DOCUMENT_PARSE_LIMITS,
  type DocumentComplexityReason,
  documentComplexity,
  isMarkdownTooComplex,
  MAX_MARKDOWN_BACKTICKS,
  MAX_MARKDOWN_BRACKET_DEPTH,
  MAX_MARKDOWN_BRACKETS,
  MAX_MARKDOWN_CONTAINER_MARKERS,
  MAX_MARKDOWN_DEPTH,
  MAX_MARKDOWN_EMPHASIS_DELIMITERS,
  MAX_MARKDOWN_INDENT_COLUMNS,
  MAX_MARKDOWN_LENGTH,
  MAX_MARKDOWN_LINE_CONTAINERS,
} from "./limits.ts";
export {
  containsRawHtml,
  type DocumentParse,
  parseDocument,
  parseMarkdownTree,
  plainTextOf,
} from "./parse.ts";
export {
  type DocumentStructure,
  SECTION_BLOCK_TARGET_CHARS,
  type SectionKind,
  type StructuralSection,
  sectionAtOffset,
  splitSections,
} from "./sections.ts";
export {
  alignToCodePoint,
  endWithinBytes,
  LineTable,
  normalizeForSearch,
  singleLine,
  utf8ByteLength,
} from "./text.ts";
