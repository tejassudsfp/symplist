import { render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EditorHandle } from "./editor.ts";
import { installJsdomLayout } from "./jsdom-layout.ts";
import { RawView } from "./raw-view.tsx";
import { positionOfOffset, sectionIndexOfHeading } from "./sections.ts";

const page = [
  "## Overview",
  "",
  "Three projects, one page.",
  "",
  "## Next steps",
  "",
  "* Pick three projects",
  "",
].join("\n");

function mount(props: Partial<Parameters<typeof RawView>[0]> = {}) {
  const ref = createRef<EditorHandle>();
  const onChange = vi.fn();
  const view = render(<RawView ref={ref} value={page} onChange={onChange} {...props} />);
  return { ref, onChange, view };
}

beforeAll(() => {
  installJsdomLayout();
});

describe("the Markdown view", () => {
  it("is an accessible multi-line text box holding the document", () => {
    mount();
    const editor = screen.getByRole("textbox", { name: "Markdown source" });
    expect(editor).toHaveAttribute("aria-multiline", "true");
    expect(editor.textContent).toContain("Three projects, one page.");
  });

  it("marks itself as the editor context, so Mod+S and Mod+F reach the page", () => {
    const { view } = mount();
    const host = view.container.querySelector('[data-slot="raw-view"]');
    expect(host?.getAttribute("data-action-context")).toBe("editor");
  });

  it("takes a custom accessible name", () => {
    mount({ label: "The draft" });
    expect(screen.getByRole("textbox", { name: "The draft" })).toBeInTheDocument();
  });

  it("is not editable when the page is read-only", () => {
    mount({ readOnly: true });
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "false");
  });

  it("becomes editable again when the page unlocks", () => {
    const { view } = mount({ readOnly: true });
    view.rerender(<RawView value={page} onChange={vi.fn()} readOnly={false} />);
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true");
  });

  it("replaces the text when a revision is published elsewhere", async () => {
    const { view } = mount();
    const next = page.replace("Pick three projects", "Pick four projects");
    view.rerender(<RawView value={next} onChange={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("textbox").textContent).toContain("Pick four projects"),
    );
  });

  it("does not echo a value it already holds back to the caller", () => {
    const { view, onChange } = mount();
    view.rerender(<RawView value={page} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports the caret as a section and an offset inside it", () => {
    const { ref } = mount();
    const at = page.indexOf("Pick three projects");
    ref.current?.setPosition(positionOfOffset(page, at));
    expect(ref.current?.position().sectionIndex).toBe(sectionIndexOfHeading(page, "Next steps"));
  });

  it("clamps a position past the end of a shortened document", () => {
    const { ref, view } = mount();
    ref.current?.setPosition({ sectionIndex: 9, offsetInSection: 9_999 });
    view.rerender(<RawView ref={ref} value={"# Short\n"} onChange={vi.fn()} />);
    expect(() =>
      ref.current?.setPosition({ sectionIndex: 9, offsetInSection: 9_999 }),
    ).not.toThrow();
    expect(ref.current?.position()).toEqual({ sectionIndex: 0, offsetInSection: 8 });
  });

  it("selects the nth match of a find and reports how many there are", () => {
    const { ref } = mount();
    expect(ref.current?.showMatch("projects", 0)).toBe(2);
    expect(ref.current?.showMatch("projects", 1)).toBe(2);
    // Past the last match, find wraps rather than stopping.
    expect(ref.current?.showMatch("projects", 2)).toBe(2);
    expect(ref.current?.showMatch("nothing here", 0)).toBe(0);
  });

  it("collapses the selection when find is closed", () => {
    const { ref } = mount();
    ref.current?.showMatch("projects", 0);
    expect(() => ref.current?.clearMatch()).not.toThrow();
  });

  it("takes focus on request", () => {
    const { ref } = mount();
    ref.current?.focus();
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("releases the handle on unmount, so nothing holds a destroyed editor", () => {
    const { ref, view } = mount();
    expect(ref.current).not.toBeNull();
    view.unmount();
    expect(ref.current).toBeNull();
  });

  it("answers safely while the editor has not been created yet", () => {
    // The handle exists from the first render; the effect that creates the editor runs after it.
    const ref = createRef<EditorHandle>();
    render(<RawView ref={ref} value={page} onChange={vi.fn()} />);
    const handle = ref.current as EditorHandle;
    expect(handle.position()).toBeDefined();
    expect(handle.showMatch("projects", 0)).toBeGreaterThanOrEqual(0);
  });
});
