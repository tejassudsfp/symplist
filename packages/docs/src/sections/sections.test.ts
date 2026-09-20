import { describe, expect, it } from "vitest";
import { decodeSnapshot, encodeSnapshot } from "../artifacts/snapshot.ts";
import { canonicalizeMarkdown } from "../markdown/index.ts";
import { hostileRoundTripDocument } from "../test-support/hostile-document.ts";
import { classifyConflict, compareSectionIndexes } from "./changes.ts";
import { CursorInvalidError, decodeCursor, encodeCursor } from "./cursor.ts";
import { outlinePage, readSectionChunk, searchSections, searchTerms } from "./navigation.ts";
import {
  buildSectionIndex,
  findSection,
  rebindSectionIndex,
  SECTION_ID_PATTERN,
  sectionId,
} from "./section-index.ts";
import { SectionNotFoundError, spliceSection } from "./splice.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const task = "0192f0a0-0000-7000-8000-000000000101";

const portfolio = `## Overview
A lighter, quieter portfolio.

## Projects to feature
- [x] Field notes app
- [ ] The typography experiments

### Photos
Export at 1600px.

## Next steps
1. Draft the about page

\`\`\`bash
# not a heading
magick in.png -resize 1600x out.webp
\`\`\`

## Links
- Current site
`;

describe("section index", () => {
  it("derives opaque revision-scoped ids, parents, children, sizes and digests", () => {
    const index = buildSectionIndex(portfolio, A);
    expect(index.sections.map((section) => section.heading)).toEqual([
      "Overview",
      "Projects to feature",
      "Photos",
      "Next steps",
      "Links",
    ]);
    for (const section of index.sections) expect(section.id).toMatch(SECTION_ID_PATTERN);
    const [, projects, photos] = index.sections;
    expect(photos?.parentId).toBe(projects?.id);
    expect(projects?.childIds).toEqual([photos?.id]);
    expect(projects?.subtreeBytes).toBeGreaterThan(projects?.bytes ?? 0);
    expect(index.sections.map((section) => section.heading).join()).not.toContain("not a heading");
    // Ids never repeat across revisions and never contain heading text.
    const other = buildSectionIndex(portfolio, B);
    expect(other.sections[0]?.id).not.toBe(index.sections[0]?.id);
    expect(other.sections[0]?.digest).toBe(index.sections[0]?.digest);
    expect(sectionId(A, "h0")).toBe(index.sections[0]?.id);
    expect(rebindSectionIndex(index, B)).toEqual(other);
    expect(index.canonical).toBe(false);
    expect(buildSectionIndex("", A)).toMatchObject({ sections: [], canonical: true, bytes: 0 });
  });

  it("round-trips through the snapshot encoding and rejects tampered shapes", () => {
    const index = buildSectionIndex(portfolio, A);
    const snapshot = {
      taskId: task,
      commitId: A,
      parentCommitId: null,
      generation: 1,
      author: "user" as const,
      kind: "create" as const,
      restoredFrom: null,
      committedAt: 1_789_000_000_000,
      subject: "Created the page",
      markdown: portfolio,
      index,
    };
    const bytes = encodeSnapshot(snapshot);
    expect(decodeSnapshot(bytes, { taskId: task, commitId: A })).toEqual(snapshot);
    expect(() => decodeSnapshot(bytes, { taskId: task, commitId: B })).toThrow(
      expect.objectContaining({ reason: "mismatch" }),
    );
    const parsed = JSON.parse(bytes.toString("utf8"));
    parsed.sections[0][7] = portfolio.length + 10;
    expect(() =>
      decodeSnapshot(Buffer.from(JSON.stringify(parsed)), { taskId: task, commitId: A }),
    ).toThrow(expect.objectContaining({ reason: "malformed" }));
  });
});

describe("outline and bounded reads (note 06)", () => {
  it("pages outline entries without body text", () => {
    const index = buildSectionIndex(portfolio, A);
    const first = outlinePage(index, 0, 2);
    expect(first.entries.map((entry) => entry.heading)).toEqual([
      "Overview",
      "Projects to feature",
    ]);
    expect(first.nextOffset).toBe(2);
    expect(JSON.stringify(first)).not.toContain("quieter");
    const last = outlinePage(index, 4, 2);
    expect(last.nextOffset).toBeNull();
  });

  it("reads a section's own content in bounded chunks and never its descendants", () => {
    const index = buildSectionIndex(portfolio, A);
    const projects = index.sections[1];
    if (!projects) throw new Error("missing");
    const whole = readSectionChunk(portfolio, projects, 0, 10_000);
    expect(whole.text).toBe(
      "## Projects to feature\n- [x] Field notes app\n- [ ] The typography experiments\n\n",
    );
    expect(whole.text).not.toContain("Photos");
    expect(whole).toMatchObject({ truncated: false, nextOffset: null, rangeStart: 0 });

    const chunks: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const chunk = readSectionChunk(portfolio, projects, offset, 20);
      expect(chunk.deliveredBytes).toBeLessThanOrEqual(20);
      chunks.push(chunk.text);
      offset = chunk.nextOffset;
    }
    expect(chunks.join("")).toBe(whole.text);
  });

  it("paginates a single huge section and never splits a surrogate pair", () => {
    const huge = `# Huge\n${"😀 emoji line\n".repeat(2_000)}`;
    const index = buildSectionIndex(huge, A);
    const section = index.sections[0];
    if (!section) throw new Error("missing");
    let offset: number | null = 0;
    let pages = 0;
    let rebuilt = "";
    while (offset !== null) {
      const chunk = readSectionChunk(huge, section, offset, 1_000);
      expect(chunk.text.length === 0 || !/^[\uDC00-\uDFFF]/.test(chunk.text)).toBe(true);
      rebuilt += chunk.text;
      offset = chunk.nextOffset;
      pages += 1;
    }
    expect(rebuilt).toBe(huge);
    expect(pages).toBeGreaterThan(20);
  });

  it("searches folded terms and returns bounded snippets with section references", () => {
    const index = buildSectionIndex(`${portfolio}\n## Café notes\nCrème brûlée budget\n`, A);
    const markdown = `${portfolio}\n## Café notes\nCrème brûlée budget\n`;
    expect(searchTerms("  Crème, BRÛLÉE! ")).toEqual(["creme", "brulee"]);
    const found = searchSections(markdown, index, "creme BUDGET", {
      offset: 0,
      limit: 5,
      snippetChars: 40,
    });
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({ heading: "Café notes", matchCount: 2 });
    expect(found.matches[0]?.snippet.length).toBeLessThanOrEqual(45);
    const paged = searchSections(markdown, index, "1600px", {
      offset: 0,
      limit: 1,
      snippetChars: 40,
    });
    expect(paged.matches).toHaveLength(1);
    expect(
      searchSections(markdown, index, "", { offset: 0, limit: 5, snippetChars: 40 }).matches,
    ).toEqual([]);
  });
});

describe("section edits (§9.2)", () => {
  it("replaces one section canonically and leaves every other section byte-identical", () => {
    const index = buildSectionIndex(portfolio, A);
    const next = index.sections[3];
    if (!next) throw new Error("missing");
    const updated = spliceSection(portfolio, index, {
      placement: "replace",
      sectionId: next.id,
      markdown: "## Next steps\n+ Draft the about page\n+ Export images\n",
    });
    const after = buildSectionIndex(updated, B);
    for (const [position, section] of index.sections.entries()) {
      if (position === 3) continue;
      const counterpart = after.sections[position];
      expect(updated.slice(counterpart?.start, counterpart?.end)).toBe(
        portfolio.slice(section.start, section.end),
      );
    }
    expect(updated).toContain(
      "## Next steps\n\n* Draft the about page\n* Export images\n\n## Links",
    );
  });

  it("keeps descendants when replacing a parent, inserts after subtrees and appends", () => {
    const index = buildSectionIndex(portfolio, A);
    const projects = index.sections[1];
    const replaced = spliceSection(portfolio, index, {
      placement: "replace",
      sectionId: projects?.id,
      markdown: "## Projects to feature\nNone yet.",
    });
    expect(replaced).toContain("None yet.\n\n### Photos");
    const inserted = spliceSection(portfolio, index, {
      placement: "after",
      sectionId: projects?.id,
      markdown: "## Budget\nUnder 200",
    });
    expect(inserted).toContain("Export at 1600px.\n\n## Budget\n\nUnder 200\n\n## Next steps");
    const appended = spliceSection("", buildSectionIndex("", A), {
      placement: "end",
      markdown: "# First",
    });
    expect(appended).toBe("# First\n");
    expect(() =>
      spliceSection(portfolio, index, {
        placement: "replace",
        sectionId: sectionId(B, "h0"),
        markdown: "x",
      }),
    ).toThrow(SectionNotFoundError);
  });

  it("never turns the following line into a setext heading or merges paragraphs", () => {
    const source = "Intro paragraph\n# Title\nBody\nNext\n===\n";
    const index = buildSectionIndex(source, A);
    const updated = spliceSection(source, index, {
      placement: "replace",
      sectionId: index.sections[0]?.id,
      markdown: "Replaced intro",
    });
    const after = buildSectionIndex(updated, B);
    expect(after.sections.map((section) => section.heading)).toEqual(
      buildSectionIndex(source, C).sections.map((section) => section.heading),
    );
  });
});

describe("changes between revisions (§9.4)", () => {
  it("reports added, modified and removed sections and nothing for formatting-only changes", () => {
    const base = buildSectionIndex(portfolio, A);
    const edited = portfolio
      .replace("A lighter, quieter portfolio.", "A lighter portfolio.")
      .replace("## Links\n- Current site\n", "## Contact\nEmail me\n");
    const target = buildSectionIndex(edited, B);
    const { changes } = compareSectionIndexes(base, target);
    expect(changes.map((change) => [change.status, change.heading])).toEqual([
      ["modified", "Overview"],
      ["added", "Contact"],
      ["removed", "Links"],
    ]);
    // The canonical form of the hostile document is content-neutral.
    const hostile = buildSectionIndex(hostileRoundTripDocument, A);
    const canonical = buildSectionIndex(canonicalizeMarkdown(hostileRoundTripDocument), B);
    expect(compareSectionIndexes(hostile, canonical).changes).toEqual([]);
  });

  it("reports nothing for changed-then-reverted content", () => {
    const base = buildSectionIndex(portfolio, A);
    const reverted = buildSectionIndex(portfolio, C);
    expect(compareSectionIndexes(base, reverted).changes).toEqual([]);
  });

  it("pairs duplicate headings conservatively", () => {
    const base = buildSectionIndex("## Notes\none\n\n## Notes\ntwo\n", A);
    const changedSecond = buildSectionIndex("## Notes\none\n\n## Notes\nTWO\n", B);
    expect(
      compareSectionIndexes(base, changedSecond).changes.map((change) => change.status),
    ).toEqual(["modified"]);
    const addedThird = buildSectionIndex("## Notes\nzero\n\n## Notes\none\n\n## Notes\ntwo\n", C);
    expect(compareSectionIndexes(base, addedThird).changes.map((change) => change.status)).toEqual([
      "added",
    ]);
    const renamedOne = buildSectionIndex(
      "## Notes\nnew one\n\n## Notes\nnew two\n\n## Notes\nthree\n",
      C,
    );
    const statuses = compareSectionIndexes(base, renamedOne).changes.map((change) => change.status);
    expect(statuses.filter((status) => status === "modified")).toEqual([]);
    expect(statuses.filter((status) => status === "added")).toHaveLength(3);
    expect(statuses.filter((status) => status === "removed")).toHaveLength(2);
  });

  it("classifies conflicts three ways and preserves unrelated sections", () => {
    const base = buildSectionIndex("## A\none\n\n## B\ntwo\n\n## C\nthree\n", A);
    const saved = buildSectionIndex("## A\nONE by agent\n\n## B\ntwo\n\n## C\nthree\n", B);
    const draft = buildSectionIndex("## A\none typed\n\n## B\ntwo\n\n## C\nTHREE typed\n", C);
    const sections = classifyConflict(base, saved, draft);
    expect(sections.map((section) => [section.heading, section.status])).toEqual([
      ["A", "both_changed"],
      ["B", "unchanged"],
      ["C", "draft_changed"],
    ]);
  });
});

describe("cursors", () => {
  it("round-trips and refuses other kinds, tasks, shapes and tampering", () => {
    const cursor = encodeCursor("c", task, { b: A, p: B, o: 3 });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, "c", task, { b: "revision", p: "revision", o: "offset" })).toEqual({
      b: A,
      p: B,
      o: 3,
    });
    const spec = { b: "revision", p: "revision", o: "offset" } as const;
    expect(() => decodeCursor(cursor, "d", task, spec)).toThrow(CursorInvalidError);
    expect(() => decodeCursor(cursor, "c", "0192f0a0-0000-7000-8000-000000000102", spec)).toThrow(
      CursorInvalidError,
    );
    expect(() =>
      decodeCursor(encodeCursor("c", task, { b: "x", p: B, o: 3 }), "c", task, spec),
    ).toThrow(CursorInvalidError);
    expect(() =>
      decodeCursor(encodeCursor("c", task, { b: A, p: B, o: -1 }), "c", task, spec),
    ).toThrow(CursorInvalidError);
    expect(() =>
      decodeCursor(encodeCursor("c", task, { b: A, p: B, o: 1, extra: 1 }), "c", task, spec),
    ).toThrow(CursorInvalidError);
    expect(() => decodeCursor("!!!", "c", task, spec)).toThrow(CursorInvalidError);
    expect(() => decodeCursor("e30", "c", task, spec)).toThrow(CursorInvalidError);
    expect(findSection(buildSectionIndex(portfolio, A), "s-missing")).toBeUndefined();
  });
});
