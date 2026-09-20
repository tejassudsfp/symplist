import { describe, expect, it } from "vitest";
import { matchesOf, wrapIndex } from "./editor.ts";

describe("matchesOf", () => {
  it("finds every case-insensitive match as a UTF-16 range", () => {
    expect(matchesOf("Next steps and next steps", "next")).toEqual([
      [0, 4],
      [15, 19],
    ]);
  });

  it("returns nothing for an empty query", () => {
    expect(matchesOf("anything", "")).toEqual([]);
  });

  it("does not overlap matches of a repeated needle", () => {
    expect(matchesOf("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it("stops after 500 matches so a pathological query cannot hang the view", () => {
    expect(matchesOf("a".repeat(2_000), "a")).toHaveLength(500);
  });
});

describe("wrapIndex", () => {
  it("wraps past the last match back to the first", () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(4, 3)).toBe(1);
  });

  it("wraps a negative index to the end", () => {
    expect(wrapIndex(-1, 3)).toBe(2);
  });

  it("is zero when there are no matches", () => {
    expect(wrapIndex(5, 0)).toBe(0);
    expect(wrapIndex(-5, 0)).toBe(0);
  });
});
