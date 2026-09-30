import { describe, expect, it } from "vitest";
import { HARNESS_LAUNCHER, locateHarness } from "./locate.ts";

const join = (...segments: string[]): string => segments.join("/");

function tree(paths: readonly string[]): (path: string) => boolean {
  const set = new Set(paths);
  return (path) => set.has(path);
}

describe("locateHarness", () => {
  it("returns the first candidate carrying a launcher and a module tree", () => {
    const located = locateHarness({
      candidates: ["/missing", "/resources/harness"],
      exists: tree([`/resources/harness/${HARNESS_LAUNCHER}`, "/resources/harness/node_modules"]),
      join,
    });
    expect(located).toEqual({
      root: "/resources/harness",
      launcher: `/resources/harness/${HARNESS_LAUNCHER}`,
    });
  });

  it("skips a tree whose vendoring ran halfway", () => {
    // A launcher with no modules would fail deep inside dsh's own resolution, where the message names
    // a plugin rather than the cause. Refusing it here is what makes "harness_missing" truthful.
    const located = locateHarness({
      candidates: ["/half"],
      exists: tree([`/half/${HARNESS_LAUNCHER}`]),
      join,
    });
    expect(located).toBeNull();
  });

  it("ignores an empty candidate, which is how an unset override arrives", () => {
    const located = locateHarness({
      candidates: ["", "/ok"],
      exists: tree([`/ok/${HARNESS_LAUNCHER}`, "/ok/node_modules"]),
      join,
    });
    expect(located?.root).toBe("/ok");
  });

  it("reports absence rather than throwing, so a build without the tree still opens", () => {
    expect(locateHarness({ candidates: ["/a", "/b"], exists: () => false, join })).toBeNull();
  });
});
