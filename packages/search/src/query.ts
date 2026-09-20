import { terms as textTerms } from "./normalize.ts";

/** The most terms one query evaluates; later terms are ignored. */
export const MAX_QUERY_TERMS = 12;

/**
 * A normalized query. Double-quoted parts are phrases that must appear contiguously; everything else
 * is a term that must appear anywhere in the field (AND). Terms also match as prefixes, so results
 * keep up while a word is still being typed (note 14).
 */
export interface ParsedQuery {
  /** Every term in typed order, duplicates kept, at most {@link MAX_QUERY_TERMS}. */
  readonly sequence: readonly string[];
  /** The distinct terms, in order of first appearance. */
  readonly terms: readonly string[];
  /** Quoted phrases of two or more terms. A quoted single term is an ordinary term. */
  readonly phrases: readonly (readonly string[])[];
}

/** Parses and normalizes a query. A query with no searchable words has no terms. */
export function parseQuery(text: string): ParsedQuery {
  const sequence: string[] = [];
  const phrases: string[][] = [];
  const source = typeof text === "string" ? text : "";
  const parts = source.split('"');
  // An odd number of quotes leaves the last part unclosed; it is read as plain text.
  const closed = parts.length % 2 === 1 ? parts.length : parts.length - 1;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string;
    const partTerms = textTerms(part);
    const room = MAX_QUERY_TERMS - sequence.length;
    if (room <= 0) break;
    const kept = partTerms.slice(0, room);
    const quoted = index % 2 === 1 && index < closed;
    if (quoted && kept.length >= 2) phrases.push(kept);
    sequence.push(...kept);
  }
  return Object.freeze({
    sequence: Object.freeze(sequence),
    terms: Object.freeze([...new Set(sequence)]),
    phrases: Object.freeze(phrases.map((phrase) => Object.freeze(phrase))),
  });
}
