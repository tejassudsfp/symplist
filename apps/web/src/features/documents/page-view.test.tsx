import { canonicalizeMarkdown } from "@symplist/docs/markdown";
import { render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { installJsdomLayout } from "./jsdom-layout.ts";
import { PageView, type PageViewHandle } from "./page-view.tsx";
import { sectionIndexOfHeading } from "./sections.ts";

const page = [
  "## Overview",
  "",
  "Three projects, one page.",
  "",
  "## Next steps",
  "",
  "* Pick three projects",
  "",
  "## Links",
  "",
  "<https://example.com/portfolio>",
  "",
].join("\n");

/**
 * The research's hostile round-trip document (§9.3), matching the fixture
 * `packages/docs/src/test-support/hostile-document.ts` covers for the serializer, minus its raw
 * HTML: a document with `html` nodes never reaches the page view, which opens read-only and sends
 * the reader to the lossless Markdown view instead.
 */
const hostileRoundTrip = `Portfolio notes
===============

Intro paragraph with __strong__ text and _emphasis_.

- dash item
+ plus item

1) first
2) second
    * nested four-space indent

- [ ] open task
- [x] done task

> quote line one
continued lazily

| Left | Center | Right |
|:-----|:------:|------:|
| a | b | c |

https://example.com/autolink and <https://example.com/angle>

Setext two
----------

\`\`\`js
# not a heading
const x = 1;
\`\`\`

***
`;

async function mount(value = page) {
  const ref = createRef<PageViewHandle>();
  const onChange = vi.fn();
  const onSelectionChange = vi.fn();
  const view = render(
    <PageView ref={ref} value={value} onChange={onChange} onSelectionChange={onSelectionChange} />,
  );
  await waitFor(() => expect(ref.current?.ready()).toBe(true));
  return { ref, onChange, onSelectionChange, view };
}

beforeAll(() => {
  installJsdomLayout();
});

describe("the page view", () => {
  it("renders the document as a page, not as Markdown source", async () => {
    await mount();
    const content = await screen.findByRole("textbox", { name: "Document, editable" });
    await waitFor(() => expect(content.querySelector("h2")).not.toBeNull());
    expect(content.textContent).toContain("Three projects, one page.");
    expect(content.textContent).not.toContain("## Overview");
    expect(content.querySelector("ul li")).not.toBeNull();
    expect(content.querySelector("a")).not.toBeNull();
  });

  it("marks itself as the editor context, so Mod+S and Mod+F reach the page", async () => {
    const { view } = await mount();
    const host = view.container.querySelector('[data-slot="page-view"]');
    expect(host?.getAttribute("data-action-context")).toBe("editor");
    expect(host).toHaveAttribute("data-ready", "true");
  });

  /**
   * Decision R7 rests on this: the page view's own serializer must already produce the canonical
   * form, so opening and closing a document publishes no change of its own and the one
   * "Formatting normalized" commit is genuinely the only formatting change.
   */
  it("serializes a canonical document back to itself, byte for byte", async () => {
    const canonical = canonicalizeMarkdown(page);
    const { onChange } = await mount(canonical);
    // Milkdown reports a change only when its serialization differs from what it was given.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves the hostile round-trip document alone once it is canonical", async () => {
    const canonical = canonicalizeMarkdown(hostileRoundTrip);
    expect(canonicalizeMarkdown(canonical)).toBe(canonical);
    const { ref, onChange } = await mount(canonical);
    await waitFor(() => expect(ref.current?.ready()).toBe(true));
    // Opening and holding the document publishes no change of its own, so the one "Formatting
    // normalized" commit is genuinely the only formatting change the reader ever sees.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the hostile document's content through a round trip", async () => {
    const canonical = canonicalizeMarkdown(hostileRoundTrip);
    await mount(canonical);
    const content = await screen.findByRole("textbox", { name: "Document, editable" });
    for (const text of ["dash item", "plus item", "first", "open task", "quote line one"]) {
      expect(content.textContent).toContain(text);
    }
    expect(content.querySelector("table")).not.toBeNull();
    expect(content.querySelector("pre")).not.toBeNull();
  });

  it("replaces the document when a revision is published elsewhere", async () => {
    const { view, ref } = await mount();
    const next = page.replace("Pick three projects", "Pick four projects");
    view.rerender(<PageView ref={ref} value={next} onChange={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("textbox").textContent).toContain("Pick four projects"),
    );
  });

  it("reports the caret as the section it sits in", async () => {
    const { ref } = await mount();
    const links = sectionIndexOfHeading(page, "Links") as number;
    ref.current?.setPosition({ sectionIndex: links, offsetInSection: 0 });
    expect(ref.current?.position().sectionIndex).toBe(links);
  });

  it("clamps a section index the document does not have", async () => {
    const { ref } = await mount();
    expect(() =>
      ref.current?.setPosition({ sectionIndex: 99, offsetInSection: 0 }, { focus: false }),
    ).not.toThrow();
    expect(ref.current?.position().sectionIndex).toBeGreaterThanOrEqual(0);
  });

  it("selects the nth match of a find and wraps past the last", async () => {
    const { ref } = await mount();
    expect(ref.current?.showMatch("projects", 0)).toBe(2);
    expect(ref.current?.showMatch("projects", 1)).toBe(2);
    expect(ref.current?.showMatch("projects", 2)).toBe(2);
    expect(ref.current?.showMatch("nothing here", 0)).toBe(0);
    expect(() => ref.current?.clearMatch()).not.toThrow();
  });

  it("searches the rendered text, not the Markdown markers", async () => {
    const { ref } = await mount();
    // `##` exists in the source but is not text anyone reading the page can see.
    expect(ref.current?.showMatch("##", 0)).toBe(0);
    expect(ref.current?.showMatch("Overview", 0)).toBe(1);
  });

  it("applies a formatting command and reports what is active at the caret", async () => {
    const { ref } = await mount();
    const overview = sectionIndexOfHeading(page, "Overview") as number;
    ref.current?.setPosition({ sectionIndex: overview + 1, offsetInSection: 2 });
    expect(ref.current?.activeCommands()).not.toContain("quote");
    expect(ref.current?.command("quote")).toBe(true);
    await waitFor(() => expect(ref.current?.activeCommands()).toContain("quote"));
  });

  it("reports a heading at the caret", async () => {
    const { ref } = await mount();
    ref.current?.setPosition({
      sectionIndex: sectionIndexOfHeading(page, "Links") as number,
      offsetInSection: 0,
    });
    await waitFor(() => expect(ref.current?.activeCommands()).toContain("heading"));
  });

  it("turns a list into a checklist and back", async () => {
    // The page view addresses content by block, so the caret is placed in a document whose first
    // block is the list itself.
    const { ref, onChange } = await mount("* Pick three projects\n* Write the intro\n");
    ref.current?.setPosition({ sectionIndex: 0, offsetInSection: 0 });
    expect(ref.current?.command("checklist")).toBe(true);
    await waitFor(() => {
      const latest = onChange.mock.calls.at(-1)?.[0] as string | undefined;
      expect(latest).toContain("* [ ] Pick three projects");
    });
    expect(ref.current?.command("checklist")).toBe(true);
    await waitFor(() => {
      const latest = onChange.mock.calls.at(-1)?.[0] as string | undefined;
      expect(latest).toContain("* Pick three projects");
    });
  });

  it("reports a command that does not apply rather than throwing", async () => {
    const { ref } = await mount("");
    expect(typeof ref.current?.command("checklist")).toBe("boolean");
  });

  it("releases the handle on unmount, so nothing holds a destroyed editor", async () => {
    const { ref, view } = await mount();
    view.unmount();
    expect(ref.current).toBeNull();
  });

  it("offers the Markdown view when the editor cannot start in this browser", async () => {
    const core = await import("@milkdown/kit/core");
    const make = vi.spyOn(core.Editor, "make").mockImplementation(() => {
      throw new Error("no editor here");
    });
    try {
      render(<PageView value={page} onChange={vi.fn()} />);
      expect(
        await screen.findByText(/The page view couldn't start in this browser/),
      ).toBeInTheDocument();
    } finally {
      make.mockRestore();
    }
  });
});
