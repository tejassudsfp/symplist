import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMarkdownTooComplex,
  MAX_MARKDOWN_DEPTH,
  MAX_MARKDOWN_LENGTH,
  SafeMarkdown,
  safeDestination,
} from "./safe-markdown.tsx";

function renderMarkdown(source: string) {
  const { container } = render(<SafeMarkdown source={source} />);
  const root = container.querySelector(".sym-markdown");
  if (!root) throw new Error("no markdown root");
  return root as HTMLElement;
}

/** Elements and attributes that must never appear in rendered untrusted content. */
function assertInert(root: HTMLElement) {
  expect(
    root.querySelectorAll(
      "script, style, iframe, object, embed, img, picture, source, video, audio, svg, math, form, input:not([type=checkbox]), link, meta, base",
    ),
  ).toHaveLength(0);
  for (const element of root.querySelectorAll("*")) {
    for (const attribute of element.getAttributeNames()) {
      expect(attribute.startsWith("on"), `${element.tagName} has ${attribute}`).toBe(false);
      expect(["style", "src", "srcset", "formaction", "xlink:href"]).not.toContain(attribute);
    }
    if (element.tagName === "A") {
      const href = element.getAttribute("href") ?? "";
      expect(href.startsWith("https://") || href.startsWith("mailto:")).toBe(true);
      expect(element.getAttribute("rel")).toBe("noopener noreferrer");
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SafeMarkdown rendering", () => {
  it("renders ordinary Markdown with GFM", () => {
    const root = renderMarkdown(
      [
        "# Plan",
        "",
        "Some **bold**, *em*, ~~gone~~ and `code`.",
        "",
        "- [x] Done item",
        "- [ ] Open item",
        "",
        "1. one",
        "2. two",
        "",
        "> quote",
        "",
        "| A | B |",
        "| :-: | --: |",
        "| 1 | 2 |",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "---",
      ].join("\n"),
    );
    expect(within(root).getByRole("heading", { level: 3, name: "Plan" })).toBeInTheDocument();
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelector("em")?.textContent).toBe("em");
    expect(root.querySelector("del")?.textContent).toBe("gone");
    expect(within(root).getByRole("checkbox", { name: "Done" })).toBeChecked();
    expect(within(root).getByRole("checkbox", { name: "Not done" })).not.toBeChecked();
    expect(root.querySelectorAll("ol > li")).toHaveLength(2);
    expect(root.querySelector("blockquote")?.textContent).toContain("quote");
    expect(root.querySelector("th")?.className).toBe("text-center");
    expect(root.querySelectorAll("td")[1]?.className).toBe("text-right");
    expect(root.querySelector("pre code")?.getAttribute("data-language")).toBe("ts");
    expect(root.querySelector("hr")).not.toBeNull();
    assertInert(root);
  });

  it("offsets heading levels so embedded content never outranks the page", () => {
    render(<SafeMarkdown source={"# Title\n\n###### Deep"} headingLevelStart={2} />);
    expect(screen.getByRole("heading", { level: 2, name: "Title" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 6, name: "Deep" })).toBeInTheDocument();
  });

  it("shows the destination host on https links and opens them safely", () => {
    const root = renderMarkdown("[our docs](https://docs.example.com/guide?x=1#top)");
    const link = within(root).getByRole("link");
    expect(link).toHaveAttribute("href", "https://docs.example.com/guide?x=1#top");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.textContent).toContain("our docs");
    expect(link.textContent).toContain("(docs.example.com)");
  });

  it("allows mailto and shows the address", () => {
    const root = renderMarkdown("[write](mailto:maya@example.com?subject=Hi)");
    const link = within(root).getByRole("link");
    expect(link.getAttribute("href")).toBe("mailto:maya@example.com?subject=Hi");
    expect(link.textContent).toContain("(maya@example.com)");
  });

  it("resolves reference-style links through the same allowlist", () => {
    const root = renderMarkdown(
      "[good][a] and [bad][b]\n\n[a]: https://ok.example\n[b]: javascript:alert(1)",
    );
    expect(within(root).getAllByRole("link")).toHaveLength(1);
    expect(root.textContent).toContain("bad");
    assertInert(root);
  });
});

describe("hostile Markdown", () => {
  it.each([
    ["script tag", "<script>alert(1)</script>"],
    ["inline event handler", '<img src=x onerror="alert(1)">'],
    ["iframe", '<iframe src="https://evil.example"></iframe>'],
    ["style injection", "<style>body{display:none}</style>"],
    ["svg payload", "<svg onload=alert(1)><circle/></svg>"],
    ["inline html in text", "hello <b onclick=alert(1)>there</b> friend"],
    ["html comment", "<!-- <script>alert(1)</script> -->"],
    ["form", '<form action="https://evil.example"><input name=x></form>'],
    ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
  ])("keeps raw HTML as literal text: %s", (_label, source) => {
    const root = renderMarkdown(source);
    assertInert(root);
    expect(root.textContent).toContain("<");
  });

  it.each([
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](java\tscript:alert(1))",
    "[x](&#106;avascript:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](vbscript:msgbox)",
    "[x](http://plain-http.example)",
    "[x](//protocol-relative.example)",
    "[x](/relative/path)",
    "[x](#fragment)",
    "[x](https://user:pass@evil.example)",
    "[x](file:///etc/passwd)",
    "<javascript:alert(1)>",
    "www.example.com",
  ])("renders a refused link as inert text: %s", (source) => {
    const root = renderMarkdown(source);
    expect(root.querySelectorAll("a")).toHaveLength(0);
    assertInert(root);
  });

  it("never fetches or embeds remote images and labels them instead", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const imageSpy = vi.spyOn(window, "Image");
    const root = renderMarkdown(
      '![Tracking pixel](https://tracker.example/p.gif "t")\n\n![](https://cdn.example/a.png)\n\n![local](/uploads/x.png)\n\n![data](data:image/png;base64,AAAA)',
    );
    expect(root.querySelectorAll("img, picture, source")).toHaveLength(0);
    const links = within(root).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Image: Tracking pixel (tracker.example) (opens in a new tab)",
      "Image: untitled (cdn.example) (opens in a new tab)",
    ]);
    expect(root.textContent).toContain("Image: local");
    expect(root.textContent).toContain("Image: data");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(imageSpy).not.toHaveBeenCalled();
    assertInert(root);
  });

  it("never nests links, even through an image inside a link", () => {
    const root = renderMarkdown("[![inner](https://img.example/x.png)](https://outer.example)");
    const links = root.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.querySelector("a")).toBeNull();
    expect(links[0]?.getAttribute("href")).toBe("https://outer.example/");
  });

  it("shows the punycode host for look-alike domains", () => {
    const root = renderMarkdown("[apple](https://аpple.com/login)");
    expect(within(root).getByRole("link").textContent).toContain("(xn--pple-43d.com)");
  });

  it("flattens nesting deeper than the render limit instead of recursing without bound", () => {
    // 40 nested list levels by indentation stay under the parser limits but exceed the render depth.
    const source = Array.from({ length: 40 }, (_, level) => `${"  ".repeat(level)}- level ${level}`)
      .join("\n")
      .concat("\n");
    expect(isMarkdownTooComplex(source)).toBe(false);
    const root = renderMarkdown(source);
    expect(root.querySelectorAll("ul").length).toBeGreaterThan(1);
    expect(root.querySelectorAll("ul").length).toBeLessThanOrEqual(MAX_MARKDOWN_DEPTH);
    expect(root.textContent).toContain("level 39");
  });

  it.each([
    // Each of these overflowed the parser's stack (a render crash) or took seconds to minutes to
    // parse while staying under the length limit.
    ["a blockquote tower on one line", `${">".repeat(40_000)} deep`],
    ["an ordered list tower", `${"1. ".repeat(13_000)}deep`],
    ["a mixed container tower", `${"> - ".repeat(3_000)}deep`],
    ["thousands of emphasis delimiters", `${"*a".repeat(20_000)} deep`],
    ["nested emphasis", `${"*a ".repeat(4_000)}deep${" a*".repeat(4_000)}`],
    ["strikethrough runs", `${"~a".repeat(20_000)} deep`],
    ["nested images", `${"![".repeat(8_000)}deep${"](y)".repeat(8_000)}`],
    ["nested link labels", `${"[".repeat(16_000)}deep${"]".repeat(16_000)}`],
    [
      "code spans of every length",
      `${Array.from({ length: 280 }, (_, i) => "`".repeat(i)).join("a")} deep`,
    ],
    [
      "a deeply indented list",
      Array.from({ length: 300 }, (_, i) => `${"  ".repeat(i)}- deep`).join("\n"),
    ],
    ["thousands of list items", "- deep\n".repeat(12_000)],
    ["thousands of footnote references", "[^deep]".repeat(7_000)],
  ])("renders %s as plain text without parsing it", (_label, source) => {
    expect(isMarkdownTooComplex(source)).toBe(true);
    const started = performance.now();
    const root = renderMarkdown(source);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(root.querySelectorAll("blockquote, ol, ul, em, strong, del, a, code")).toHaveLength(0);
    expect(root.querySelector("p")?.textContent).toBe(source);
    assertInert(root);
  });

  it("keeps parsing realistic long messages under the complexity limits", () => {
    const section = [
      "## Projects to feature",
      "",
      "A **lighter**, quieter portfolio with _fewer_ projects and `better` writing.",
      "",
      "- [x] Field notes app, see [the notes](https://example.com/notes)",
      "- [ ] Library redesign for the ~~city~~ archive",
      "  1. Export images at 1600px",
      "  2. Check every link",
      "",
      "> Rule of thumb: if I wouldn't bring it up in a conversation, it doesn't go on the site.",
      "",
      "```sh",
      "magick in.png -resize 1600x -quality 82 out.webp",
      "```",
      "",
    ].join("\n");
    const source = section.repeat(40);
    expect(source.length).toBeGreaterThan(10_000);
    expect(isMarkdownTooComplex(source)).toBe(false);
    const root = renderMarkdown(source);
    expect(root.querySelectorAll("h4")).toHaveLength(40);
    expect(root.querySelectorAll("a")).toHaveLength(40);
  });

  it("renders oversized input as plain text", () => {
    const source = `<script>${"a".repeat(MAX_MARKDOWN_LENGTH)}</script>`;
    const root = renderMarkdown(source);
    assertInert(root);
    expect(root.querySelector("p")?.textContent?.startsWith("<script>")).toBe(true);
  });
});

describe("safeDestination", () => {
  it.each([
    [
      "https://example.com/a",
      { href: "https://example.com/a", display: "example.com", kind: "https" },
    ],
    [
      "  https://EXAMPLE.com  ",
      { href: "https://example.com/", display: "example.com", kind: "https" },
    ],
    ["mailto:a@b.example", { href: "mailto:a@b.example", display: "a@b.example", kind: "mailto" }],
  ])("allows %j", (input, expected) => {
    expect(safeDestination(input)).toEqual(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "https://",
    "mailto:",
    "mailto:not-an-address",
    "mailto:%E0%A4%A",
    "http://example.com",
    "ftp://example.com",
    `https://example.com/${"a".repeat(3000)}`,
    `https://example.com/a${String.fromCharCode(7)}b`,
    `https://example.com/a${String.fromCharCode(0x2028)}b`,
  ])("refuses %j", (input) => {
    expect(safeDestination(input)).toBeNull();
  });
});
