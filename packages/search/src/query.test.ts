import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk.ts";
import {
  boundedEditDistance,
  matchTerm,
  maxTypoEdits,
  phraseOccurrences,
  textRules,
  titleRules,
} from "./match.ts";
import { MAX_QUERY_TERMS, parseQuery } from "./query.ts";

/** Whether a string has no lone surrogates (encodeURIComponent throws on them). */
function wellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

describe("parseQuery", () => {
  it("normalizes terms and keeps typed order", () => {
    const query = parseQuery("  Pottery CLASS pottery ");
    expect(query.sequence).toEqual(["pottery", "class", "pottery"]);
    expect(query.terms).toEqual(["pottery", "class"]);
    expect(query.phrases).toEqual([]);
  });

  it("reads double-quoted parts as phrases and single quoted words as terms", () => {
    const query = parseQuery('"community garden" budget "Outline"');
    expect(query.phrases).toEqual([["community", "garden"]]);
    expect(query.sequence).toEqual(["community", "garden", "budget", "outline"]);
  });

  it("treats an unclosed quote as plain text", () => {
    const query = parseQuery('project "outline draft');
    expect(query.phrases).toEqual([]);
    expect(query.terms).toEqual(["project", "outline", "draft"]);
  });

  it("has no terms for queries without searchable words", () => {
    expect(parseQuery("!!! 👍 --").terms).toEqual([]);
  });

  it("evaluates at most twelve terms", () => {
    const query = parseQuery(Array.from({ length: 30 }, (_, index) => `t${index}`).join(" "));
    expect(query.sequence).toHaveLength(MAX_QUERY_TERMS);
  });
});

describe("term matching rules", () => {
  it("bounds typos by term length", () => {
    expect(maxTypoEdits("book")).toBe(0);
    expect(maxTypoEdits("potery")).toBe(1);
    expect(maxTypoEdits("portfolio")).toBe(2);
    expect(matchTerm("book", "look", titleRules)).toBeNull();
    expect(matchTerm("potery", "pottery", titleRules)).toBe("typo");
    expect(matchTerm("portflio", "portfolio", titleRules)).toBe("typo");
    expect(matchTerm("prtflo", "portfolio", titleRules)).toBeNull();
  });

  it("never applies typos to headings, bodies or chat", () => {
    expect(matchTerm("potery", "pottery", textRules)).toBeNull();
  });

  it("matches prefixes from one character in titles and two in text", () => {
    expect(matchTerm("b", "bike", titleRules)).toBe("prefix");
    expect(matchTerm("b", "bike", textRules)).toBeNull();
    expect(matchTerm("bi", "bike", textRules)).toBe("prefix");
    expect(matchTerm("bike", "bike", textRules)).toBe("exact");
  });

  it("computes bounded edit distances over code points", () => {
    expect(boundedEditDistance("kitten", "sitting", 3)).toBe(3);
    expect(boundedEditDistance("kitten", "sitting", 2)).toBe(3);
    expect(boundedEditDistance("東京都", "東京", 1)).toBe(1);
    expect(boundedEditDistance("a", "abcdef", 2)).toBe(3);
  });

  it("finds contiguous phrases, with an optional prefix for the last term", () => {
    const sequence = ["the", "community", "garden", "project", "community", "gardens"];
    expect(phraseOccurrences(["community", "garden"], sequence)).toEqual([1]);
    expect(phraseOccurrences(["community", "garden"], sequence, true)).toEqual([1, 4]);
    expect(phraseOccurrences(["garden", "community"], sequence)).toEqual([]);
  });
});

describe("chunkText (long documents)", () => {
  const options = { chunkChars: 120, overlapChars: 20 };

  it("keeps short texts whole, including empty ones", () => {
    expect(chunkText("", options)).toEqual([{ start: 0, text: "" }]);
    expect(chunkText("short", options)).toEqual([{ start: 0, text: "short" }]);
  });

  it("covers every character with bounded, overlapping chunks cut at whitespace", () => {
    const words = Array.from({ length: 400 }, (_, index) => `word${index}`);
    const text = words.join(" ");
    const chunks = chunkText(text, options);
    expect(chunks.length).toBeGreaterThan(10);
    let covered = 0;
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.text.length).toBeLessThanOrEqual(options.chunkChars);
      expect(text.slice(chunk.start, chunk.start + chunk.text.length)).toBe(chunk.text);
      expect(chunk.start).toBeLessThanOrEqual(covered);
      covered = Math.max(covered, chunk.start + chunk.text.length);
      if (index > 0) expect(text.charAt(chunk.start - 1)).toBe(" ");
    }
    expect(covered).toBe(text.length);
    expect(chunkText(text, options)).toEqual(chunks);
  });

  it("never splits a surrogate pair when a text has no whitespace", () => {
    const text = "𝐀".repeat(200);
    for (const chunk of chunkText(text, options)) {
      expect(wellFormed(chunk.text)).toBe(true);
    }
  });

  it("rejects unusable limits", () => {
    expect(() => chunkText("x", { chunkChars: 4, overlapChars: 0 })).toThrow(RangeError);
    expect(() => chunkText("x", { chunkChars: 100, overlapChars: 60 })).toThrow(RangeError);
  });
});
