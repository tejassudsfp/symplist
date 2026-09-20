import { describe, expect, it } from "vitest";
import { findMarkerIn } from "./markers.ts";

const marker = "MARKER-7f3a";

describe("findMarkerIn", () => {
  it("finds markers in strings, keys, errors, dates, maps, sets and bytes", () => {
    const cause = new Error(`cause ${marker}`);
    const value = {
      plain: "nothing",
      nested: { list: ["a", `b ${marker}`] },
      [`key-${marker}`]: 1,
      error: new Error("wrapped", { cause }),
      map: new Map([["k", marker]]),
      set: new Set([`s${marker}`]),
      bytes: new TextEncoder().encode(`bytes ${marker}`),
      when: new Date(0),
    };
    const paths = findMarkerIn(value, marker).map((location) => location.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "$.nested.list[1]",
        `\${key-${marker}}`,
        "$.error.cause.message",
        "$.map[k]",
        "$.set{0}",
        "$.bytes",
      ]),
    );
    expect(paths.some((path) => path.startsWith("$.error.cause.stack"))).toBe(true);
    expect(paths.some((path) => path.startsWith("$.plain"))).toBe(false);
  });

  it("handles cycles, primitives and absent values", () => {
    const cyclic: Record<string, unknown> = { text: marker };
    cyclic.self = cyclic;
    expect(findMarkerIn(cyclic, marker)).toEqual([{ path: "$.text" }]);
    expect(findMarkerIn(null, marker)).toEqual([]);
    expect(findMarkerIn(42, "42")).toEqual([{ path: "$" }]);
    expect(() => findMarkerIn("x", "")).toThrow();
  });
});
