import { describe, expect, it } from "vitest";
import {
  FractionalIndexError,
  isValidPositionKey,
  keyBetween,
  keysBetween,
} from "./fractional-index.ts";

describe("fractional index keys (§3.4)", () => {
  it("starts at a0 and continues the fixture sequence a0, a1, a2, a3", () => {
    expect(keyBetween(null, null)).toBe("a0");
    expect(keyBetween("a0", null)).toBe("a1");
    expect(keyBetween("a1", null)).toBe("a2");
    expect(keyBetween("a2", null)).toBe("a3");
    expect(keyBetween(null, "a0")).toBe("Zz");
  });

  it("always produces a key strictly between its neighbours", () => {
    const pairs: Array<[string | null, string | null]> = [
      ["a0", "a1"],
      ["a0", "a0V"],
      ["Zz", "a0"],
      ["a1", "b00"],
      [null, "a0V"],
      ["az", null],
      ["zzzzzzzzzzzzzzzzzzzzzzzzzzz", null],
    ];
    for (const [before, after] of pairs) {
      const key = keyBetween(before, after);
      expect(isValidPositionKey(key)).toBe(true);
      if (before !== null) expect(key > before).toBe(true);
      if (after !== null) expect(key < after).toBe(true);
    }
  });

  it("keeps order under thousands of random insertions", () => {
    const keys: string[] = [];
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 3_000; round += 1) {
      const index = Math.floor(random() * (keys.length + 1));
      const key = keyBetween(keys[index - 1] ?? null, keys[index] ?? null);
      keys.splice(index, 0, key);
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("spreads several keys between two neighbours in order", () => {
    for (const [before, after] of [
      [null, null],
      ["a0", null],
      [null, "a0"],
      ["a0", "a1"],
    ] as Array<[string | null, string | null]>) {
      const keys = keysBetween(before, after, 7);
      expect(keys).toHaveLength(7);
      expect([...keys].sort()).toEqual(keys);
      if (before !== null) expect((keys[0] as string) > before).toBe(true);
      if (after !== null) expect((keys[6] as string) < after).toBe(true);
    }
    expect(keysBetween("a0", "a1", 0)).toEqual([]);
  });

  it("refuses keys out of order, equal neighbours and malformed keys", () => {
    expect(() => keyBetween("a1", "a0")).toThrow(FractionalIndexError);
    expect(() => keyBetween("a1", "a1")).toThrow(FractionalIndexError);
    for (const bad of ["", "0", "a", "a00", "a1!", "A00000000000000000000000000"]) {
      expect(isValidPositionKey(bad)).toBe(false);
    }
    expect(() => keyBetween("a", null)).toThrow(FractionalIndexError);
    expect(() => keysBetween(null, null, -1)).toThrow(FractionalIndexError);
  });
});
