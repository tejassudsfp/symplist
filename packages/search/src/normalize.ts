/**
 * Text normalization and tokenization shared by indexing, querying and highlighting (§10.1, note 14).
 * Every term in the index, every query term and every highlighted token passes through exactly this
 * code, so a match found by the index can always be located again in the original text.
 *
 * Normalization: NFKD, strip combining marks, lowercase, NFKD and strip again (lowercasing can
 * introduce marks), then a fixed fold table for letters NFKD leaves alone (`ß`→`ss`, `æ`→`ae`, …)
 * and apostrophes removed, so `CAFÉ`, `café` and `cafe`, `Straße` and `strasse`, `İstanbul` and
 * `istanbul`, full-width `ＡＢＣ` and `abc`, the ligature `ﬁle` and `file`, and `don't` and `dont`
 * all meet. Tokenization uses `Intl.Segmenter` word segmentation with a fixed locale, so scripts
 * without spaces (Japanese, Chinese, Thai) split into words rather than one run.
 */

/** The version of the serialized index layout; a stored index with another version is rebuilt. */
export const INDEX_FORMAT_VERSION = 1;

/** Terms longer than this are cut, so pasted blobs cannot bloat the index. */
export const MAX_TERM_LENGTH = 64;

/**
 * Identifies the normalization and tokenization rules. It names the algorithm, not the ICU build: the
 * api and the worker may run different Node patch releases, and a fingerprint that included the ICU
 * version would make them rebuild each other's indexes forever. Change it whenever the rules below
 * change, which makes every stored index rebuild.
 */
export const TOKENIZER_FINGERPRINT =
  "symplist-tokenizer/1;nfkd;strip-marks;lower;fold-1;no-apostrophes;icu-word-en;max-term-64";

const combiningMarks = /\p{M}+/gu;
const apostrophes = /['‘’ʼ＇]/g;

/** Letters that NFKD does not decompose, folded to their conventional ASCII spelling (fold table 1). */
const foldTable: Readonly<Record<string, string>> = Object.freeze({
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  ł: "l",
  ı: "i",
  þ: "th",
  ħ: "h",
  ŧ: "t",
});
const foldPattern = new RegExp(`[${Object.keys(foldTable).join("")}]`, "g");

/** Normalizes one word into its index term; returns the empty string when nothing searchable is left. */
export function normalizeTerm(word: string): string {
  if (typeof word !== "string" || word.length === 0) return "";
  let term = word.normalize("NFKD").replace(combiningMarks, "").toLowerCase();
  term = term.normalize("NFKD").replace(combiningMarks, "");
  term = term
    .replace(foldPattern, (letter) => foldTable[letter] ?? letter)
    .replace(apostrophes, "");
  if (term.length > MAX_TERM_LENGTH) {
    // Never cut through a surrogate pair.
    let end = MAX_TERM_LENGTH;
    const code = term.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    term = term.slice(0, end);
  }
  return term;
}

/** One word of a text: its UTF-16 range in the original text and its normalized term. */
export interface TextToken {
  readonly start: number;
  readonly end: number;
  readonly term: string;
}

// A fixed locale keeps segmentation independent of the process's default locale (the host's LANG).
const segmenter = new Intl.Segmenter("en", { granularity: "word" });

/** The words of a text in order, with their original offsets. Punctuation, spaces and emoji are skipped. */
export function tokenize(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  if (typeof text !== "string" || text.length === 0) return tokens;
  for (const segment of segmenter.segment(text)) {
    if (!segment.isWordLike) continue;
    const term = normalizeTerm(segment.segment);
    if (term.length === 0) continue;
    tokens.push({ start: segment.index, end: segment.index + segment.segment.length, term });
  }
  return tokens;
}

/** The normalized terms of a text, in order (duplicates kept). */
export function terms(text: string): string[] {
  return tokenize(text).map((token) => token.term);
}

/** The number of Unicode code points in a term. */
export function codePointLength(term: string): number {
  let length = 0;
  for (const _ of term) length += 1;
  return length;
}
