import { describe, expect, it } from "vitest";
import { textRules, titleRules } from "./match.ts";
import { parseQuery } from "./query.ts";
import { buildSnippet, highlightText } from "./snippet.ts";

function marked(text: string, highlights: readonly { start: number; end: number }[]): string {
  let output = "";
  let cursor = 0;
  for (const range of highlights) {
    output += `${text.slice(cursor, range.start)}[${text.slice(range.start, range.end)}]`;
    cursor = range.end;
  }
  return output + text.slice(cursor);
}

describe("highlightText", () => {
  it("highlights exact, prefix and bounded typo matches in titles", () => {
    const title = "Try the pottery class";
    expect(marked(title, highlightText(title, parseQuery("pot clas"), titleRules))).toBe(
      "Try the [pottery] [class]",
    );
    expect(marked(title, highlightText(title, parseQuery("potery"), titleRules))).toBe(
      "Try the [pottery] class",
    );
  });

  it("highlights quoted phrases as one range and maps Unicode offsets in the original text", () => {
    const text = "Café crème and the community garden";
    expect(
      marked(text, highlightText(text, parseQuery('cafe "community garden"'), textRules)),
    ).toBe("[Café] crème and the [community garden]");
  });

  it("treats markup as text", () => {
    const text = '<script>alert("x")</script> script tag';
    const ranges = highlightText(text, parseQuery("script"), textRules);
    expect(marked(text, ranges)).toBe('<[script]>alert("x")</[script]> [script] tag');
  });

  it("caps the number of ranges", () => {
    const text = Array.from({ length: 40 }, () => "echo").join(" ");
    expect(highlightText(text, parseQuery("echo"), textRules)).toHaveLength(16);
  });
});

describe("buildSnippet", () => {
  const long = `${"Intro sentence about nothing in particular. ".repeat(10)}The kingfisher appeared near the pond at dawn. ${"Closing filler text that goes on. ".repeat(10)}`;

  it("returns short texts whole with whitespace collapsed", () => {
    const snippet = buildSnippet("  Bring the\n\n  camera   please ", parseQuery("camera"), {
      rules: textRules,
    });
    expect(snippet).toEqual({
      text: "Bring the camera please",
      highlights: [{ start: 10, end: 16 }],
      truncatedStart: false,
      truncatedEnd: false,
    });
  });

  it("centres a bounded window on the first match at word boundaries", () => {
    const snippet = buildSnippet(long, parseQuery("kingfisher"), {
      rules: textRules,
      maxChars: 80,
    });
    expect(snippet.text.length).toBeLessThanOrEqual(80);
    expect(snippet.truncatedStart).toBe(true);
    expect(snippet.truncatedEnd).toBe(true);
    expect(marked(snippet.text, snippet.highlights)).toContain("[kingfisher]");
    // Windows start and end on whole words.
    const words = new Set(long.split(/\s+/));
    const pieces = snippet.text.split(" ");
    expect(words.has(pieces[0] as string)).toBe(true);
    expect(words.has(pieces[pieces.length - 1] as string)).toBe(true);
  });

  it("anchors on the first phrase occurrence when the query has one", () => {
    const text = `pond ${"x ".repeat(120)}the kingfisher near the pond`;
    const snippet = buildSnippet(text, parseQuery('"the pond"'), {
      rules: textRules,
      maxChars: 40,
    });
    expect(marked(snippet.text, snippet.highlights)).toContain("[the pond]");
  });

  it("starts at the beginning when nothing in the text matches", () => {
    const snippet = buildSnippet(long, parseQuery("absent"), { rules: textRules, maxChars: 60 });
    expect(snippet.truncatedStart).toBe(false);
    expect(snippet.text.startsWith("Intro sentence")).toBe(true);
    expect(snippet.highlights).toEqual([]);
  });

  it("reports context that precedes or follows a chunk", () => {
    const snippet = buildSnippet("middle of a section", parseQuery("section"), {
      rules: textRules,
      precededByText: true,
      followedByText: true,
    });
    expect(snippet.truncatedStart).toBe(true);
    expect(snippet.truncatedEnd).toBe(true);
  });

  it("is deterministic", () => {
    const first = buildSnippet(long, parseQuery("pond dawn"), { rules: textRules, maxChars: 90 });
    expect(buildSnippet(long, parseQuery("pond dawn"), { rules: textRules, maxChars: 90 })).toEqual(
      first,
    );
  });

  it("keeps markup as literal text in snippets", () => {
    const snippet = buildSnippet('<img src=x onerror="steal()"> photo', parseQuery("photo"), {
      rules: textRules,
    });
    expect(snippet.text).toBe('<img src=x onerror="steal()"> photo');
  });
});
