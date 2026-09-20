/**
 * Text helpers shared by the browser and the server. Offsets are UTF-16 code unit indices, the unit
 * mdast positions use; byte counts are UTF-8, the unit budgets and limits use. Nothing here imports
 * `node:*`.
 */

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** UTF-8 bytes of a code unit at `index` together with its pair, and how many units it spans. */
function unitBytes(
  text: string,
  index: number,
): { readonly bytes: number; readonly units: number } {
  const code = text.charCodeAt(index);
  if (code < 0x80) return { bytes: 1, units: 1 };
  if (code < 0x800) return { bytes: 2, units: 1 };
  if (isHighSurrogate(code) && index + 1 < text.length) {
    if (isLowSurrogate(text.charCodeAt(index + 1))) return { bytes: 4, units: 2 };
  }
  // Lone surrogates encode as U+FFFD (3 bytes) in well-formed UTF-8 output.
  return { bytes: 3, units: 1 };
}

/** The UTF-8 length of a string without allocating an encoded copy. */
export function utf8ByteLength(text: string, start = 0, end = text.length): number {
  let bytes = 0;
  let index = start;
  while (index < end) {
    const unit = unitBytes(text, index);
    bytes += unit.bytes;
    index += unit.units;
  }
  return bytes;
}

/**
 * The largest end index (at most `limit`) such that `text.slice(start, end)` is at most `maxBytes`
 * UTF-8 bytes and never splits a surrogate pair. Returns `start` when not even one character fits.
 */
export function endWithinBytes(text: string, start: number, maxBytes: number, limit = text.length) {
  let bytes = 0;
  let index = start;
  while (index < limit) {
    const unit = unitBytes(text, index);
    if (bytes + unit.bytes > maxBytes) break;
    bytes += unit.bytes;
    index += unit.units;
  }
  return Math.min(index, limit);
}

/** Moves an index off the middle of a surrogate pair (toward the start). */
export function alignToCodePoint(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
  return isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1))
    ? index - 1
    : index;
}

/**
 * Search normalization (§10.1 tokenizer): NFKD, combining marks stripped, lower-cased. Returns the
 * normalized text together with a map from each normalized code unit to its source index, so a match
 * can be located in the original text for snippets.
 */
export function normalizeForSearch(text: string): {
  readonly text: string;
  readonly map: number[];
} {
  let normalized = "";
  const map: number[] = [];
  let index = 0;
  while (index < text.length) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      // ASCII is its own NFKD form and has no marks.
      normalized += unit >= 65 && unit <= 90 ? String.fromCharCode(unit + 32) : text[index];
      map.push(index);
      index += 1;
      continue;
    }
    const code = text.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(code);
    const folded = character.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    for (let n = 0; n < folded.length; n += 1) map.push(index);
    normalized += folded;
    index += character.length;
  }
  return { text: normalized, map };
}

/** Collapses runs of whitespace and trims, for headings and snippets shown on one line. */
export function singleLine(text: string, maxLength = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, alignToCodePoint(collapsed, maxLength - 1))}…`;
}

/** 1-based line numbers for offsets, from a precomputed table of line start offsets. */
export class LineTable {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) this.starts.push(index + 1);
    }
  }

  /** The 1-based line containing `offset`. */
  lineOf(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }

  get lineCount(): number {
    return this.starts.length;
  }
}
