import { describe, expect, it } from "vitest";
import {
  DOCUMENT_START,
  headingOfSection,
  lineOfPosition,
  offsetOfLine,
  offsetOfPosition,
  positionOfOffset,
  sectionIndexOfBlockStart,
  sectionIndexOfHeading,
  structureOf,
} from "./sections.ts";

const document = [
  "Some opening text.",
  "",
  "## Overview",
  "",
  "A short paragraph.",
  "",
  "## Next steps",
  "",
  "* [ ] Pick three projects",
  "* [ ] Write the intro",
  "",
].join("\n");

describe("structureOf", () => {
  it("partitions the whole document into sections", () => {
    const { sections } = structureOf(document);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections[0]?.start).toBe(0);
    expect(sections.at(-1)?.end).toBe(document.length);
    for (let index = 1; index < sections.length; index += 1) {
      expect(sections[index]?.start).toBe(sections[index - 1]?.end);
    }
  });

  it("never throws on a document past the parser work limits", () => {
    expect(() => structureOf(`${"a*b ".repeat(2_500)}\n\n# Real\n`)).not.toThrow();
  });
});

describe("positionOfOffset and offsetOfPosition", () => {
  it("round-trips every offset in the document", () => {
    for (let offset = 0; offset <= document.length; offset += 1) {
      expect(offsetOfPosition(document, positionOfOffset(document, offset))).toBe(offset);
    }
  });

  it("is the document start for an empty document", () => {
    expect(positionOfOffset("", 0)).toEqual(DOCUMENT_START);
    expect(offsetOfPosition("", { sectionIndex: 4, offsetInSection: 9 })).toBe(0);
  });

  it("clamps an offset outside the document", () => {
    expect(offsetOfPosition(document, positionOfOffset(document, -10))).toBe(0);
    expect(offsetOfPosition(document, positionOfOffset(document, 10_000))).toBe(document.length);
  });

  it("clamps a position whose section shrank since it was taken", () => {
    const index = sectionIndexOfHeading(document, "Next steps") as number;
    const shorter = "## Next steps\n";
    const offset = offsetOfPosition(shorter, { sectionIndex: index, offsetInSection: 500 });
    expect(offset).toBeLessThanOrEqual(shorter.length);
  });

  it("puts a caret inside the section its heading starts", () => {
    const at = document.indexOf("Pick three projects");
    const position = positionOfOffset(document, at);
    expect(headingOfSection(document, position.sectionIndex)).toBe("Next steps");
  });
});

describe("lineOfPosition and offsetOfLine", () => {
  it("agrees with the document's own line breaks", () => {
    const at = document.indexOf("## Next steps");
    const line = document.slice(0, at).split("\n").length;
    expect(lineOfPosition(document, positionOfOffset(document, at))).toBe(line);
    expect(offsetOfLine(document, line)).toBe(at);
  });

  it("clamps a line before the first and past the last", () => {
    expect(offsetOfLine(document, 0)).toBe(0);
    expect(offsetOfLine(document, 1)).toBe(0);
    expect(offsetOfLine(document, 10_000)).toBe(document.length);
  });
});

describe("headingOfSection and sectionIndexOfHeading", () => {
  it("names each heading section and nothing else", () => {
    const overview = sectionIndexOfHeading(document, "Overview") as number;
    expect(headingOfSection(document, overview)).toBe("Overview");
    expect(headingOfSection(document, 0)).toBeNull();
    expect(headingOfSection(document, 99)).toBeNull();
  });

  it("is null for a heading the document does not have", () => {
    expect(sectionIndexOfHeading(document, "Nowhere")).toBeNull();
  });

  it("resolves duplicate headings to the first one", () => {
    const duplicated = "## A\n\none\n\n## A\n\ntwo\n";
    expect(sectionIndexOfHeading(duplicated, "A")).toBe(0);
  });
});

describe("sectionIndexOfBlockStart", () => {
  it("maps a block's start offset to the section it opens", () => {
    const at = document.indexOf("## Overview");
    expect(sectionIndexOfBlockStart(document, at)).toBe(
      sectionIndexOfHeading(document, "Overview"),
    );
  });
});
