import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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

  it("flattens pathological nesting instead of recursing without bound", () => {
    const source = `${">".repeat(5000)} deep`;
    const root = renderMarkdown(source);
    expect(root.querySelectorAll("blockquote").length).toBeLessThanOrEqual(MAX_MARKDOWN_DEPTH);
    expect(root.textContent).toContain("deep");
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
