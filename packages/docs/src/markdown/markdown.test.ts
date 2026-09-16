import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostileRoundTripDocument } from "../test-support/hostile-document.ts";
import {
  CANONICAL_STRINGIFY_OPTIONS,
  canonicalizeMarkdown,
  comparableSectionText,
  DOCUMENT_PARSE_LIMITS,
  documentComplexity,
  endWithinBytes,
  isCanonicalMarkdown,
  isMarkdownTooComplex,
  LineTable,
  MarkdownTooComplexError,
  normalizeForSearch,
  parseDocument,
  parseMarkdownTree,
  plainTextOf,
  safeDestination,
  sectionAtOffset,
  singleLine,
  splitSections,
  utf8ByteLength,
} from "./index.ts";
import * as limits from "./limits.ts";

describe("parser work limits (§10.4, decision W5)", () => {
  it("uses exactly the web SafeMarkdown limits", () => {
    const web = readFileSync(
      fileURLToPath(
        new URL("../../../../apps/web/src/components/markdown/safe-markdown.tsx", import.meta.url),
      ),
      "utf8",
    );
    const declared = [...web.matchAll(/export const (MAX_MARKDOWN_[A-Z_]+) = ([\d_]+);/g)];
    expect(declared.length).toBeGreaterThanOrEqual(9);
    for (const [, name, value] of declared) {
      expect((limits as Record<string, unknown>)[name as string], name).toBe(
        Number((value as string).replaceAll("_", "")),
      );
    }
  });

  it("refuses hostile chat-sized sources and accepts realistic ones", () => {
    expect(isMarkdownTooComplex("a*b ".repeat(2_001))).toBe(true);
    expect(isMarkdownTooComplex("[".repeat(33))).toBe(true);
    expect(isMarkdownTooComplex(`${"> ".repeat(17)}x`)).toBe(true);
    expect(isMarkdownTooComplex(`${" ".repeat(97)}x`)).toBe(true);
    expect(isMarkdownTooComplex("x".repeat(50_001))).toBe(true);
    expect(
      isMarkdownTooComplex("A *short* message with `code` and [a link](https://x.test)."),
    ).toBe(false);
  });

  it("applies per-paragraph limits and a total work budget to documents", () => {
    const paragraph = "a*b ".repeat(1_500);
    expect(documentComplexity(Array.from({ length: 5 }, () => paragraph).join("\n\n"))).toEqual({
      parseable: true,
      reason: null,
    });
    expect(documentComplexity("a*b ".repeat(2_001)).reason).toBe("chunk_delimiters");
    expect(
      documentComplexity(Array.from({ length: 40 }, () => paragraph).join("\n\n")).reason,
    ).toBe("quadratic_work");
    expect(
      documentComplexity(Array.from({ length: 20_001 }, (_, k) => `- item ${k}`).join("\n")).reason,
    ).toBe("container_markers");
    expect(documentComplexity("x".repeat(DOCUMENT_PARSE_LIMITS.maxLength + 1)).reason).toBe(
      "length",
    );
  });

  it("parses within the limits and falls back without throwing beyond them", () => {
    expect(parseDocument("## Title\n\nBody").mode).toBe("parsed");
    const hostile = parseDocument(`${"- ".repeat(17)}x`);
    expect(hostile).toEqual({ mode: "fallback", reason: "line_containers" });
  });
});

describe("splitSections (§9.1)", () => {
  it("returns no sections for an empty or blank document", () => {
    expect(splitSections("").sections).toEqual([]);
    expect(splitSections("\n  \n").sections).toEqual([]);
  });

  it("splits headings, keeps an addressable preamble and partitions the document", () => {
    const source = "Intro line.\n\n# Top\nTop body\n\n## Child\nChild body\n\n# Second\nEnd\n";
    const { sections, mode } = splitSections(source);
    expect(mode).toBe("parsed");
    expect(sections.map((section) => [section.path, section.kind, section.heading])).toEqual([
      ["p", "preamble", null],
      ["h0", "heading", "Top"],
      ["h1", "heading", "Child"],
      ["h2", "heading", "Second"],
    ]);
    expect(sections[0]?.start).toBe(0);
    for (let index = 1; index < sections.length; index += 1) {
      expect(sections[index]?.start).toBe(sections[index - 1]?.end);
    }
    expect(sections.at(-1)?.end).toBe(source.length);
    const [, top, child, second] = sections;
    expect(child?.parentPath).toBe("h0");
    expect(second?.parentPath).toBeNull();
    expect(top?.subtreeEnd).toBe(second?.start);
    expect(source.slice(top?.start, top?.end)).toBe("# Top\nTop body\n\n");
    expect(source.slice(top?.start, top?.bodyStart)).toBe("# Top");
    expect(top?.lineStart).toBe(3);
    expect(top?.lineEnd).toBe(5);
  });

  it("treats duplicate headings as distinct sections and ignores headings inside code and containers", () => {
    const source = [
      "## Budget",
      "first",
      "",
      "```md",
      "## Budget",
      "```",
      "",
      "> ## Quoted heading",
      "",
      "- ## Listed heading",
      "",
      "## Budget",
      "second",
      "",
    ].join("\n");
    const { sections } = splitSections(source);
    expect(sections.map((section) => section.heading)).toEqual(["Budget", "Budget"]);
    expect(source.slice(sections[0]?.start, sections[0]?.end)).toContain("```md\n## Budget\n```");
    expect(sections[0]?.path).not.toBe(sections[1]?.path);
  });

  it("detects setext headings and merges blank leading lines into the first section", () => {
    const { sections } = splitSections("\n\nTitle\n=====\n\nBody\n");
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ kind: "heading", depth: 1, heading: "Title", start: 0 });
  });

  it("splits heading-free documents into bounded blocks of whole nodes", () => {
    const fence = `\`\`\`\n${"code line\n".repeat(30)}\`\`\`\n\n`;
    const paragraph = `${"words ".repeat(30)}\n\n`;
    const source = Array.from({ length: 12 }, (_, k) => (k % 3 === 0 ? fence : paragraph)).join("");
    const { sections } = splitSections(source, { blockTargetChars: 500 });
    expect(sections.length).toBeGreaterThan(2);
    expect(sections.every((section) => section.kind === "block")).toBe(true);
    for (const section of sections) {
      const text = source.slice(section.start, section.end);
      // A block never ends inside a fence: every block has balanced fence markers.
      expect((text.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(sections.at(-1)?.end).toBe(source.length);
  });

  it("indexes documents beyond the work limits with the fence-aware line scanner", () => {
    const hostile = `${"a*b ".repeat(2_500)}\n\n# Real\n\n\`\`\`\n# fenced\n\`\`\`\n\n## Also real ##\nbody\n`;
    const structure = splitSections(hostile);
    expect(structure.mode).toBe("fallback");
    expect(structure.fallbackReason).toBe("chunk_delimiters");
    expect(structure.sections.map((section) => section.heading)).toEqual([
      null,
      "Real",
      "Also real",
    ]);
    expect(structure.sections.at(-1)?.end).toBe(hostile.length);
  });

  it("flags raw HTML and finds the section at an offset", () => {
    const structure = splitSections("# A\n\n<div>raw</div>\n\n# B\nx\n");
    expect(structure.hasRawHtml).toBe(true);
    expect(sectionAtOffset(structure, 21)?.heading).toBe("B");
    expect(splitSections("# A\n\nplain\n").hasRawHtml).toBe(false);
  });
});

describe("canonical serializer (§9.2, §9.3)", () => {
  it("uses the frozen §9 options", () => {
    expect(CANONICAL_STRINGIFY_OPTIONS).toEqual({
      bullet: "*",
      emphasis: "*",
      strong: "_",
      rule: "-",
      fences: true,
      listItemIndent: "one",
    });
  });

  it("normalizes the hostile round-trip document without losing content and reaches a fixed point", () => {
    const canonical = canonicalizeMarkdown(hostileRoundTripDocument);
    expect(canonicalizeMarkdown(canonical)).toBe(canonical);
    expect(isCanonicalMarkdown(canonical)).toBe(true);
    expect(isCanonicalMarkdown(hostileRoundTripDocument)).toBe(false);
    // Every character of text, code and link destinations survives normalization.
    const before = parseMarkdownTree(hostileRoundTripDocument);
    const after = parseMarkdownTree(canonical);
    expect(plainTextOf(after).replace(/\s+/g, " ")).toBe(plainTextOf(before).replace(/\s+/g, " "));
    const urls = (tree: typeof before) => JSON.stringify(tree).match(/"url":"[^"]*"/g);
    expect(urls(after)).toEqual(urls(before));
    // Inline HTML is kept as HTML, never dropped silently.
    expect(canonical).toContain("<br>");
    expect(canonical).toContain("# not a heading");
    expect(canonical).toContain("[^1]: The footnote text.");
    // Formatting is canonical: setext became ATX, markers and delimiters are normalized.
    expect(canonical).toMatch(/^# Portfolio notes$/m);
    expect(canonical).toMatch(/^## Setext two$/m);
    expect(canonical).not.toMatch(/^\+ /m);
    expect(canonical).toContain("__strong__");
    expect(splitSections(canonical).sections.map((section) => section.heading)).toEqual(
      splitSections(hostileRoundTripDocument).sections.map((section) => section.heading),
    );
  });

  it("treats formatting-only section differences as content-neutral", () => {
    expect(comparableSectionText("Title\n=====\n\n+ one\n+ two\n")).toBe(
      comparableSectionText("# Title\n\n* one\n* two\n"),
    );
    expect(comparableSectionText("# Title\n\n* one\n")).not.toBe(
      comparableSectionText("# Title\n\n* uno\n"),
    );
  });

  it("refuses to normalize documents beyond the work limits", () => {
    expect(() => canonicalizeMarkdown(`${"- ".repeat(17)}x`)).toThrow(MarkdownTooComplexError);
    expect(isCanonicalMarkdown(`${"- ".repeat(17)}x`)).toBe(false);
    expect(canonicalizeMarkdown("   ")).toBe("");
  });
});

describe("text helpers", () => {
  it("counts UTF-8 bytes and never splits surrogate pairs", () => {
    expect(utf8ByteLength("aé😀")).toBe(1 + 2 + 4);
    const text = "ab😀cd";
    expect(endWithinBytes(text, 0, 3)).toBe(2);
    expect(endWithinBytes(text, 0, 6)).toBe(4);
    expect(endWithinBytes(text, 2, 3)).toBe(2);
  });

  it("normalizes for search with a map back to source offsets", () => {
    const { text, map } = normalizeForSearch("Crème BRÛLÉE");
    expect(text).toBe("creme brulee");
    expect(map[text.indexOf("brulee")]).toBe("Crème BRÛLÉE".indexOf("BRÛLÉE"));
  });

  it("collapses headings to one bounded line and maps offsets to lines", () => {
    expect(singleLine("  a \n b  ")).toBe("a b");
    expect(singleLine("x".repeat(300), 10)).toHaveLength(10);
    const lines = new LineTable("a\nbb\n\nc");
    expect([lines.lineOf(0), lines.lineOf(2), lines.lineOf(5), lines.lineOf(6)]).toEqual([
      1, 2, 3, 4,
    ]);
  });
});

describe("safeDestination (§10.4)", () => {
  it("allows only https and mailto destinations", () => {
    expect(safeDestination("https://example.com/a")).toMatchObject({ display: "example.com" });
    expect(safeDestination("mailto:maya@example.com")).toMatchObject({ kind: "mailto" });
    for (const refused of [
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,x",
      "//example.com",
      "https://user:pw@example.com",
      "/relative",
    ]) {
      expect(safeDestination(refused), refused).toBeNull();
    }
  });
});
