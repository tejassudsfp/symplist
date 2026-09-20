import { describe, expect, it } from "vitest";
import {
  codePointLength,
  INDEX_FORMAT_VERSION,
  MAX_TERM_LENGTH,
  normalizeTerm,
  TOKENIZER_FINGERPRINT,
  terms,
  tokenize,
} from "./normalize.ts";

/** Whether a string has no lone surrogates (encodeURIComponent throws on them). */
function wellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

describe("normalizeTerm (§10.1 NFKD, mark stripping, lowercase)", () => {
  it.each([
    ["CAFÉ", "cafe"],
    ["café", "cafe"],
    ["café", "cafe"],
    ["Résumé", "resume"],
    ["Straße", "strasse"],
    ["STRASSE", "strasse"],
    ["İstanbul", "istanbul"],
    ["ıstanbul", "istanbul"],
    ["ＡＢＣ", "abc"],
    ["ﬁle", "file"],
    ["Ærøskøbing", "aeroskobing"],
    ["Łódź", "lodz"],
    ["don't", "dont"],
    ["don’t", "dont"],
    ["Ÿ", "y"],
    ["Ǆ", "dz"],
    ["東京", "東京"],
    ["नमस्ते", "नमसत"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeTerm(input)).toBe(expected);
  });

  it("is idempotent", () => {
    for (const sample of ["CAFÉ", "Straße", "ﬁle", "İstanbul", "Ωμέγα", "ｶﾞ", "𝐀𝐁𝐂", "don’t"]) {
      const once = normalizeTerm(sample);
      expect(normalizeTerm(once)).toBe(once);
    }
  });

  it("cuts very long terms without splitting a surrogate pair", () => {
    expect(normalizeTerm("a".repeat(200))).toHaveLength(MAX_TERM_LENGTH);
    const emojiLike = `${"b".repeat(MAX_TERM_LENGTH - 1)}𝐀`;
    const cut = normalizeTerm(emojiLike);
    expect(cut.length).toBeLessThanOrEqual(MAX_TERM_LENGTH);
    expect(wellFormed(cut)).toBe(true);
  });

  it("returns nothing searchable for marks alone or empty input", () => {
    expect(normalizeTerm("́̂")).toBe("");
    expect(normalizeTerm("")).toBe("");
  });
});

describe("tokenize (Intl.Segmenter word boundaries)", () => {
  it("keeps original offsets for every word and skips punctuation, spaces and emoji", () => {
    const text = "Book a bike tune-up 👍🏽 — café!";
    const tokens = tokenize(text);
    expect(tokens.map((token) => token.term)).toEqual(["book", "a", "bike", "tune", "up", "cafe"]);
    for (const token of tokens) {
      expect(normalizeTerm(text.slice(token.start, token.end))).toBe(token.term);
    }
  });

  it("splits scripts without spaces into words", () => {
    expect(terms("東京に行きます")).toEqual(["東京", "に", "行き", "ます"]);
    expect(terms("สวัสดีครับ").length).toBeGreaterThan(1);
  });

  it("keeps words with inner apostrophes and dotted names together", () => {
    expect(terms("Don't email maya@example.com about 1600px")).toEqual([
      "dont",
      "email",
      "maya",
      "example.com",
      "about",
      "1600px",
    ]);
  });

  it("does not depend on the process default locale", () => {
    const tokens = terms("İstanbul’da Straße 東京");
    expect(tokens).toEqual(["istanbulda", "strasse", "東京"]);
  });
});

describe("index identity", () => {
  it("names the rules, not the ICU build, so api and worker agree", () => {
    expect(TOKENIZER_FINGERPRINT).toBe(
      "symplist-tokenizer/1;nfkd;strip-marks;lower;fold-1;no-apostrophes;icu-word-en;max-term-64",
    );
    expect(TOKENIZER_FINGERPRINT).not.toContain(process.versions.icu ?? "no-icu");
    expect(INDEX_FORMAT_VERSION).toBe(1);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(codePointLength("𝐀𝐁")).toBe(2);
    expect(codePointLength("abc")).toBe(3);
  });
});
