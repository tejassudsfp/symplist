/**
 * Parser work limits (§10.4, decision W5). The Markdown parser is superlinear (and recursive) on some
 * inputs: thousands of emphasis delimiters, deeply nested brackets, or towers of container markers
 * take seconds to minutes or overflow the stack well under any length limit. These are the exact
 * limits the web's `SafeMarkdown` applies to untrusted Markdown (chat messages, tool activity,
 * approval previews, notification text, document previews): sources beyond them render as plain text.
 */
export const MAX_MARKDOWN_LENGTH = 50_000;
/** Deeper nesting (hostile blockquote or list towers) is flattened to text by renderers. */
export const MAX_MARKDOWN_DEPTH = 24;
export const MAX_MARKDOWN_EMPHASIS_DELIMITERS = 2_000;
export const MAX_MARKDOWN_BACKTICKS = 2_000;
export const MAX_MARKDOWN_BRACKETS = 2_000;
export const MAX_MARKDOWN_BRACKET_DEPTH = 32;
export const MAX_MARKDOWN_LINE_CONTAINERS = 16;
export const MAX_MARKDOWN_CONTAINER_MARKERS = 4_000;
export const MAX_MARKDOWN_INDENT_COLUMNS = 96;

const listMarkerPattern = /^(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/;

interface LineScan {
  /** Index of the first character after leading indentation and container markers. */
  readonly contentIndex: number;
  readonly columns: number;
  readonly containers: number;
}

function scanLinePrefix(line: string): LineScan {
  let index = 0;
  let columns = 0;
  let containers = 0;
  while (index < line.length) {
    const character = line[index];
    if (character === " ") {
      columns += 1;
      index += 1;
    } else if (character === "\t") {
      columns += 4 - (columns % 4);
      index += 1;
    } else if (character === ">") {
      containers += 1;
      index += 1;
    } else {
      const marker = listMarkerPattern.exec(line.slice(index, index + 11));
      if (!marker) break;
      containers += 1;
      index += marker[0].length;
    }
  }
  return { contentIndex: index, columns, containers };
}

/**
 * A linear pre-scan that decides whether a source is cheap enough to parse: emphasis and
 * strikethrough delimiters, backticks, brackets and their open depth within a paragraph, container
 * markers (`>` and list markers) per line and in total, and leading indentation. Code blocks are
 * counted too: whether a line is code depends on the surrounding containers and HTML blocks, so
 * skipping "probable" code would let crafted input past the limits. Identical to the web's
 * `SafeMarkdown` pre-scan.
 */
export function isMarkdownTooComplex(source: string): boolean {
  if (source.length > MAX_MARKDOWN_LENGTH) return true;
  let delimiters = 0;
  let backticks = 0;
  let brackets = 0;
  let bracketDepth = 0;
  let containerMarkers = 0;
  for (const line of source.split("\n")) {
    const { contentIndex, columns, containers } = scanLinePrefix(line);
    let index = contentIndex;
    containerMarkers += containers;
    if (
      columns > MAX_MARKDOWN_INDENT_COLUMNS ||
      containers > MAX_MARKDOWN_LINE_CONTAINERS ||
      containerMarkers > MAX_MARKDOWN_CONTAINER_MARKERS
    ) {
      return true;
    }
    // Links never span a blank line, so bracket depth is tracked per paragraph.
    if (index >= line.length) bracketDepth = 0;
    for (; index < line.length; index += 1) {
      const character = line[index];
      if (character === "\\") {
        index += 1;
      } else if (character === "*" || character === "_" || character === "~") {
        delimiters += 1;
      } else if (character === "`") {
        backticks += 1;
      } else if (character === "[") {
        brackets += 1;
        bracketDepth += 1;
        if (bracketDepth > MAX_MARKDOWN_BRACKET_DEPTH || brackets > MAX_MARKDOWN_BRACKETS) {
          return true;
        }
      } else if (character === "]" && bracketDepth > 0) {
        bracketDepth -= 1;
      }
    }
    if (delimiters > MAX_MARKDOWN_EMPHASIS_DELIMITERS || backticks > MAX_MARKDOWN_BACKTICKS) {
      return true;
    }
  }
  return false;
}

/**
 * Work limits for task documents, which may be up to `DOC_MAX_BYTES` (1 MiB) and are parsed on the
 * server to build section indexes (§9.1). Inline parsing is quadratic per paragraph, so the chat
 * limits apply per blank-line-delimited chunk, with a total quadratic work budget across chunks; list
 * and blockquote parsing is superlinear in the number of container markers, which is capped for the
 * whole document. Measured on Node 24 (decision DOC.3): a realistic 1 MiB document parses in about
 * 1.3 s, and sources at these limits stay within a few seconds. Documents beyond them are indexed by
 * the line scanner instead of the parser, never refused.
 */
export const DOCUMENT_PARSE_LIMITS = Object.freeze({
  /** Longest document (UTF-16 code units) the parser may see; `DOC_MAX_BYTES` caps bytes separately. */
  maxLength: 1_048_576,
  /** Per paragraph chunk, as for chat. */
  maxChunkDelimiters: MAX_MARKDOWN_EMPHASIS_DELIMITERS,
  maxChunkBackticks: MAX_MARKDOWN_BACKTICKS,
  maxChunkBrackets: MAX_MARKDOWN_BRACKETS,
  maxBracketDepth: MAX_MARKDOWN_BRACKET_DEPTH,
  maxLineContainers: MAX_MARKDOWN_LINE_CONTAINERS,
  maxIndentColumns: MAX_MARKDOWN_INDENT_COLUMNS,
  /** Container markers (list items, `>`) across the whole document. */
  maxContainerMarkers: 20_000,
  /** Sum over chunks of the squared delimiter, backtick and bracket counts. */
  maxQuadraticWork: 60_000_000,
});

export type DocumentComplexityReason =
  | "length"
  | "indentation"
  | "line_containers"
  | "container_markers"
  | "chunk_delimiters"
  | "chunk_backticks"
  | "chunk_brackets"
  | "bracket_depth"
  | "quadratic_work";

/**
 * Whether a task document is cheap enough for the Markdown parser, with the first limit it breaks.
 * Linear in the source length.
 */
export function documentComplexity(source: string): {
  readonly parseable: boolean;
  readonly reason: DocumentComplexityReason | null;
} {
  const limits = DOCUMENT_PARSE_LIMITS;
  const refuse = (reason: DocumentComplexityReason) => ({ parseable: false, reason });
  if (source.length > limits.maxLength) return refuse("length");
  let delimiters = 0;
  let backticks = 0;
  let brackets = 0;
  let bracketDepth = 0;
  let containerMarkers = 0;
  let work = 0;
  const closeChunk = (): DocumentComplexityReason | null => {
    work += delimiters * delimiters + backticks * backticks + brackets * brackets;
    delimiters = 0;
    backticks = 0;
    brackets = 0;
    bracketDepth = 0;
    return work > limits.maxQuadraticWork ? "quadratic_work" : null;
  };
  for (const line of source.split("\n")) {
    const { contentIndex, columns, containers } = scanLinePrefix(line);
    containerMarkers += containers;
    if (columns > limits.maxIndentColumns) return refuse("indentation");
    if (containers > limits.maxLineContainers) return refuse("line_containers");
    if (containerMarkers > limits.maxContainerMarkers) return refuse("container_markers");
    if (contentIndex >= line.length || line.trim().length === 0) {
      const reason = closeChunk();
      if (reason) return refuse(reason);
      continue;
    }
    for (let index = contentIndex; index < line.length; index += 1) {
      const character = line[index];
      if (character === "\\") {
        index += 1;
      } else if (character === "*" || character === "_" || character === "~") {
        delimiters += 1;
      } else if (character === "`") {
        backticks += 1;
      } else if (character === "[") {
        brackets += 1;
        bracketDepth += 1;
        if (bracketDepth > limits.maxBracketDepth) return refuse("bracket_depth");
      } else if (character === "]" && bracketDepth > 0) {
        bracketDepth -= 1;
      }
    }
    if (delimiters > limits.maxChunkDelimiters) return refuse("chunk_delimiters");
    if (backticks > limits.maxChunkBackticks) return refuse("chunk_backticks");
    if (brackets > limits.maxChunkBrackets) return refuse("chunk_brackets");
  }
  const reason = closeChunk();
  return reason ? refuse(reason) : { parseable: true, reason: null };
}
