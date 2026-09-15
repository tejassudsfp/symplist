import {
  alignToCodePoint,
  endWithinBytes,
  normalizeForSearch,
  singleLine,
  utf8ByteLength,
} from "../markdown/index.ts";
import type { IndexedSection, SectionIndex } from "./section-index.ts";

/** One outline entry (note 06 `task_document_outline`): references and sizes, never body text. */
export interface OutlineEntry {
  readonly sectionId: string;
  readonly parentId: string | null;
  readonly kind: IndexedSection["kind"];
  readonly depth: number;
  readonly heading: string | null;
  readonly bytes: number;
  readonly subtreeBytes: number;
  readonly childCount: number;
}

export function outlineEntry(section: IndexedSection): OutlineEntry {
  return Object.freeze({
    sectionId: section.id,
    parentId: section.parentId,
    kind: section.kind,
    depth: section.depth,
    heading: section.heading,
    bytes: section.bytes,
    subtreeBytes: section.subtreeBytes,
    childCount: section.childIds.length,
  });
}

/** A bounded page of outline entries starting at `offset`. */
export function outlinePage(
  index: SectionIndex,
  offset: number,
  limit: number,
): { readonly entries: readonly OutlineEntry[]; readonly nextOffset: number | null } {
  const entries = index.sections.slice(offset, offset + limit).map(outlineEntry);
  const next = offset + entries.length;
  return { entries, nextOffset: next < index.sections.length ? next : null };
}

export interface SectionChunk {
  /** The delivered text. */
  readonly text: string;
  /** Delivered range relative to the section's start, in UTF-16 code units: `[rangeStart, rangeEnd)`. */
  readonly rangeStart: number;
  readonly rangeEnd: number;
  /** Where the next chunk starts, or null when this chunk reaches the end of the section. */
  readonly nextOffset: number | null;
  readonly truncated: boolean;
  readonly deliveredBytes: number;
}

/**
 * A bounded chunk of a section's own content (never its descendants, note 06), starting `offset` code
 * units into the section and at most `maxBytes` UTF-8 bytes. Breaks after a newline when one falls in
 * the last quarter of the chunk, and never inside a surrogate pair. At least one character is always
 * delivered when any remain and `maxBytes >= 4`.
 */
export function readSectionChunk(
  markdown: string,
  section: IndexedSection,
  offset: number,
  maxBytes: number,
): SectionChunk {
  const length = section.end - section.start;
  const start = Math.max(
    section.start,
    alignToCodePoint(markdown, section.start + Math.min(offset, length)),
  );
  if (start >= section.end) {
    return {
      text: "",
      rangeStart: length,
      rangeEnd: length,
      nextOffset: null,
      truncated: false,
      deliveredBytes: 0,
    };
  }
  let end = endWithinBytes(markdown, start, maxBytes, section.end);
  if (end < section.end && end > start) {
    const newline = markdown.lastIndexOf("\n", end - 1);
    if (newline >= start && newline + 1 > start + (end - start) * 0.75) end = newline + 1;
  }
  const text = markdown.slice(start, end);
  const truncated = end < section.end;
  return {
    text,
    rangeStart: start - section.start,
    rangeEnd: end - section.start,
    nextOffset: truncated ? end - section.start : null,
    truncated,
    deliveredBytes: utf8ByteLength(text),
  };
}

export interface SearchMatch {
  readonly sectionId: string;
  readonly heading: string | null;
  readonly kind: IndexedSection["kind"];
  /** A single-line excerpt around the first match, at most about `snippetChars` characters. */
  readonly snippet: string;
  readonly matchCount: number;
}

/** Normalized search terms: at most 8 distinct terms of at most 64 characters. */
export function searchTerms(query: string): string[] {
  const terms = normalizeForSearch(query)
    .text.split(/[\s\p{P}]+/u)
    .map((term) => term.slice(0, 64))
    .filter((term) => term.length > 0);
  return [...new Set(terms)].slice(0, 8);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = haystack.indexOf(needle);
  while (from !== -1 && count < 10_000) {
    count += 1;
    from = haystack.indexOf(needle, from + needle.length);
  }
  return count;
}

/**
 * Sections containing every term (NFKD-folded, case-insensitive), in document order, from `offset`,
 * with bounded snippets. `scanned` counts the sections examined so a caller can page without rescanning.
 */
export function searchSections(
  markdown: string,
  index: SectionIndex,
  query: string,
  options: { readonly offset: number; readonly limit: number; readonly snippetChars: number },
): { readonly matches: readonly SearchMatch[]; readonly nextOffset: number | null } {
  const terms = searchTerms(query);
  const matches: SearchMatch[] = [];
  if (terms.length === 0) return { matches, nextOffset: null };
  for (let position = options.offset; position < index.sections.length; position += 1) {
    const section = index.sections[position] as IndexedSection;
    const source = markdown.slice(section.start, section.end);
    const normalized = normalizeForSearch(source);
    if (!terms.every((term) => normalized.text.includes(term))) continue;
    if (matches.length === options.limit) return { matches, nextOffset: position };
    const first = normalized.text.indexOf(terms[0] as string);
    const at = normalized.map[first] ?? 0;
    const half = Math.floor(options.snippetChars / 3);
    const from = alignToCodePoint(source, Math.max(0, at - half));
    const to = alignToCodePoint(source, Math.min(source.length, from + options.snippetChars));
    const excerpt = singleLine(source.slice(from, to), options.snippetChars);
    matches.push({
      sectionId: section.id,
      heading: section.heading,
      kind: section.kind,
      snippet: `${from > 0 ? "…" : ""}${excerpt}${to < source.length ? "…" : ""}`,
      matchCount: terms.reduce((sum, term) => sum + countOccurrences(normalized.text, term), 0),
    });
  }
  return { matches, nextOffset: null };
}
