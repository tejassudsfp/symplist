import { describe, expect, it } from "vitest";
import {
  blockIndexOfOffset,
  blockIndexOfSection,
  positionOfBlock,
  topLevelBlockStarts,
} from "./blocks.ts";
import { sectionIndexOfHeading } from "./sections.ts";

const document = [
  "Opening paragraph.",
  "",
  "## Overview",
  "",
  "A short paragraph.",
  "",
  "## Next steps",
  "",
  "* [ ] Pick three projects",
  "",
].join("\n");

describe("topLevelBlockStarts", () => {
  it("starts at zero and lists one offset per top-level block", () => {
    const starts = topLevelBlockStarts(document);
    expect(starts[0]).toBe(0);
    expect(starts).toContain(document.indexOf("## Overview"));
    expect(starts).toContain(document.indexOf("## Next steps"));
    expect(starts).toContain(document.indexOf("* [ ] Pick"));
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]).toBeGreaterThan(starts[index - 1] as number);
    }
  });

  it("has no blocks for an empty document", () => {
    expect(topLevelBlockStarts("")).toEqual([]);
  });

  it("falls back to a single block when the document is past the parser limits", () => {
    expect(topLevelBlockStarts(`${"a*b ".repeat(2_500)}\n`)).toEqual([0]);
  });
});

describe("blockIndexOfOffset", () => {
  it("is the last block starting at or before the offset", () => {
    const starts = [0, 10, 20];
    expect(blockIndexOfOffset(starts, 0)).toBe(0);
    expect(blockIndexOfOffset(starts, 9)).toBe(0);
    expect(blockIndexOfOffset(starts, 10)).toBe(1);
    expect(blockIndexOfOffset(starts, 999)).toBe(2);
  });

  it("is -1 when there are no blocks", () => {
    expect(blockIndexOfOffset([], 3)).toBe(-1);
  });
});

describe("blockIndexOfSection and positionOfBlock", () => {
  it("round-trips a section through the page view's block index", () => {
    const nextSteps = sectionIndexOfHeading(document, "Next steps") as number;
    const block = blockIndexOfSection(document, nextSteps);
    expect(positionOfBlock(document, block).sectionIndex).toBe(nextSteps);
  });

  it("clamps a section index out of range to a real block", () => {
    expect(blockIndexOfSection(document, 999)).toBeGreaterThanOrEqual(0);
    expect(blockIndexOfSection(document, -5)).toBe(0);
  });

  it("clamps a block index out of range and starts an empty document at the top", () => {
    expect(positionOfBlock(document, 999).sectionIndex).toBeGreaterThanOrEqual(0);
    expect(positionOfBlock("", 3)).toEqual({ sectionIndex: 0, offsetInSection: 0 });
  });
});
