import type { SearchHighlight, SearchSnippet } from "@symplist/contracts";
import { SEARCH_LIMITS } from "./limits.ts";
import { type MatchRules, matchTerm, phraseOccurrences } from "./match.ts";
import { type TextToken, tokenize } from "./normalize.ts";
import type { ParsedQuery } from "./query.ts";

/**
 * Deterministic, safe snippets and highlights (note 14). Highlights are UTF-16 ranges into plain
 * text: nothing here produces or interprets markup, so a snippet containing `<script>` is just text.
 */

interface Range {
  start: number;
  end: number;
}

function mergeRanges(ranges: Range[], max: number): Range[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start < last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged.slice(0, max);
}

function matchRanges(tokens: readonly TextToken[], query: ParsedQuery, rules: MatchRules): Range[] {
  const ranges: Range[] = [];
  const sequence = tokens.map((token) => token.term);
  for (const phrase of query.phrases) {
    for (const start of phraseOccurrences(phrase, sequence)) {
      const first = tokens[start] as TextToken;
      const last = tokens[start + phrase.length - 1] as TextToken;
      ranges.push({ start: first.start, end: last.end });
    }
  }
  for (const token of tokens) {
    if (query.terms.some((term) => matchTerm(term, token.term, rules) !== null)) {
      ranges.push({ start: token.start, end: token.end });
    }
  }
  return ranges;
}

/** Highlight ranges for a whole short text such as a title or heading. */
export function highlightText(
  text: string,
  query: ParsedQuery,
  rules: MatchRules,
  max: number = SEARCH_LIMITS.maxHighlights,
): SearchHighlight[] {
  if (text.length === 0 || query.terms.length === 0) return [];
  return mergeRanges(matchRanges(tokenize(text), query, rules), max);
}

export interface SnippetOptions {
  readonly rules: MatchRules;
  /** Window length before whitespace is collapsed. */
  readonly maxChars?: number;
  readonly maxHighlights?: number;
  /** Text precedes `text` in its source (a later chunk of a section). */
  readonly precededByText?: boolean;
  /** Text follows `text` in its source. */
  readonly followedByText?: boolean;
}

const whitespace = /\s/;

/**
 * A window of about `maxChars` characters around the first phrase match (or the first term match),
 * starting at a word boundary about a third of the window before the match and ending at a word
 * boundary. Whitespace runs collapse to one space. Without a match the window starts at the text's
 * beginning. The same text and query always produce the same snippet.
 */
export function buildSnippet(
  text: string,
  query: ParsedQuery,
  options: SnippetOptions,
): SearchSnippet {
  const maxChars = options.maxChars ?? SEARCH_LIMITS.snippetChars;
  const maxHighlights = options.maxHighlights ?? SEARCH_LIMITS.maxHighlights;
  const tokens = tokenize(text);
  const ranges = mergeRanges(matchRanges(tokens, query, options.rules), Number.POSITIVE_INFINITY);
  const sequence = tokens.map((token) => token.term);
  let anchor = 0;
  const phraseStart = query.phrases
    .flatMap((phrase) => phraseOccurrences(phrase, sequence))
    .sort((left, right) => left - right)[0];
  if (phraseStart !== undefined) anchor = (tokens[phraseStart] as TextToken).start;
  else if (ranges[0]) anchor = ranges[0].start;

  let begin = 0;
  let end = text.length;
  if (text.length > maxChars) {
    begin = Math.max(0, anchor - Math.floor(maxChars / 3));
    if (begin > 0) {
      const next = tokens.find((token) => token.start >= begin);
      begin = next ? Math.min(next.start, anchor) : anchor;
    }
    if (begin + maxChars < text.length) {
      end = begin + maxChars;
      let last: TextToken | undefined;
      for (const token of tokens) {
        if (token.start >= begin && token.end <= end) last = token;
      }
      if (last && last.end > anchor) end = last.end;
    } else {
      // The window reaches the end: pull it back so it still holds maxChars of text.
      end = text.length;
      const pulled = Math.max(0, end - maxChars);
      if (pulled < begin) {
        const next = tokens.find((token) => token.start >= pulled);
        begin = next ? Math.min(next.start, begin) : begin;
      }
    }
  }

  // Collapse whitespace and map offsets from the source window into the snippet text.
  const positions = new Array<number>(end - begin + 1);
  let output = "";
  for (let index = begin; index < end; index += 1) {
    positions[index - begin] = output.length;
    const char = text.charAt(index);
    if (whitespace.test(char)) {
      if (output.length > 0 && !output.endsWith(" ")) output += " ";
    } else {
      output += char;
    }
  }
  positions[end - begin] = output.length;
  if (output.endsWith(" ")) output = output.slice(0, -1);

  const highlights: SearchHighlight[] = [];
  for (const range of ranges) {
    if (range.start < begin || range.end > end) continue;
    const start = positions[range.start - begin] as number;
    const finish = Math.min(output.length, (positions[range.end - 1 - begin] as number) + 1);
    if (finish > start) highlights.push({ start, end: finish });
    if (highlights.length >= maxHighlights) break;
  }
  return {
    text: output,
    highlights,
    truncatedStart: begin > 0 || options.precededByText === true,
    truncatedEnd: end < text.length || options.followedByText === true,
  };
}
