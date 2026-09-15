import { codePointLength } from "./normalize.ts";

/**
 * Deterministic term matching used to classify hits and to highlight them (note 14). MiniSearch finds
 * candidates; these rules decide what counts as an exact, prefix or typo match, so ranking and
 * highlighting never depend on MiniSearch's internal scoring.
 */

export type TermMatch = "exact" | "prefix" | "typo";

/** Title terms accept prefixes from the first character (the palette matches as you type). */
export const TITLE_MIN_PREFIX = 1;

/** Heading, body and chat terms need at least two characters before prefix matching applies. */
export const TEXT_MIN_PREFIX = 2;

/**
 * Bounded typo tolerance for task titles: no typos under 5 characters (so `book` never matches
 * `look`), one edit from 5 to 8 characters, two edits from 9 characters. Typos never apply to
 * headings, bodies or chat.
 */
export function maxTypoEdits(term: string): number {
  const length = codePointLength(term);
  if (length < 5) return 0;
  if (length < 9) return 1;
  return 2;
}

/**
 * The Levenshtein distance between two terms over code points, or `max + 1` as soon as it must exceed
 * `max` (so the work stays bounded by the query term's length).
 */
export function boundedEditDistance(left: string, right: string, max: number): number {
  const a = [...left];
  const b = [...right];
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  const distance = previous[b.length] as number;
  return distance > max ? max + 1 : distance;
}

export interface MatchRules {
  /** Prefix matching applies to query terms at least this long; 0 disables it. */
  readonly minPrefix: number;
  /** Whether bounded typos count (task titles only). */
  readonly typo: boolean;
}

export const titleRules: MatchRules = Object.freeze({ minPrefix: TITLE_MIN_PREFIX, typo: true });
export const textRules: MatchRules = Object.freeze({ minPrefix: TEXT_MIN_PREFIX, typo: false });

/** How a query term matches a document term, or null. Exact beats prefix beats typo. */
export function matchTerm(query: string, candidate: string, rules: MatchRules): TermMatch | null {
  if (query === candidate) return "exact";
  if (
    rules.minPrefix > 0 &&
    candidate.length > query.length &&
    candidate.startsWith(query) &&
    codePointLength(query) >= rules.minPrefix
  ) {
    return "prefix";
  }
  if (rules.typo) {
    const max = maxTypoEdits(query);
    if (max > 0 && boundedEditDistance(query, candidate, max) <= max) return "typo";
  }
  return null;
}

/**
 * Where a phrase (a sequence of exact terms) occurs contiguously in a term list: the indexes of each
 * occurrence's first term. The last phrase term may be a prefix when `lastIsPrefix` is set.
 */
export function phraseOccurrences(
  phrase: readonly string[],
  sequence: readonly string[],
  lastIsPrefix = false,
): number[] {
  const found: number[] = [];
  if (phrase.length === 0 || phrase.length > sequence.length) return found;
  for (let start = 0; start + phrase.length <= sequence.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < phrase.length; offset += 1) {
      const term = phrase[offset] as string;
      const candidate = sequence[start + offset] as string;
      const isLast = offset === phrase.length - 1;
      if (
        candidate !== term &&
        !(
          isLast &&
          lastIsPrefix &&
          codePointLength(term) >= TEXT_MIN_PREFIX &&
          candidate.startsWith(term)
        )
      ) {
        matches = false;
        break;
      }
    }
    if (matches) found.push(start);
  }
  return found;
}
