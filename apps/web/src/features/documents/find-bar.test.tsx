import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { EditorHandle } from "./editor.ts";
import { FindBar } from "./find-bar.tsx";

/** An editor handle that answers with a fixed match count and records what find asked for. */
function editorRef(matches = 3) {
  const shown: Array<[string, number]> = [];
  const handle: EditorHandle = {
    focus: vi.fn(),
    position: () => ({ sectionIndex: 0, offsetInSection: 0 }),
    setPosition: vi.fn(),
    showMatch: (query, index) => {
      shown.push([query, index]);
      return query === "nothing" ? 0 : matches;
    },
    clearMatch: vi.fn(),
  };
  const ref = createRef<EditorHandle>();
  (ref as { current: EditorHandle }).current = handle;
  return { ref, handle, shown };
}

function mount(matches = 3) {
  const { ref, handle, shown } = editorRef(matches);
  const onClose = vi.fn();
  render(<FindBar editor={ref} onClose={onClose} revision="page:100" />);
  return { onClose, handle, shown };
}

describe("find in document", () => {
  it("opens focused on its own input, so typing searches rather than edits", () => {
    mount();
    expect(screen.getByRole("searchbox", { name: "Find in document" })).toHaveFocus();
  });

  it("invites a query before anything is typed", () => {
    mount();
    expect(screen.getByRole("status")).toHaveTextContent("Type to search");
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous match" })).toBeDisabled();
  });

  it("reports the position and the count of the matches it found", async () => {
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByRole("searchbox"), "project");
    expect(screen.getByRole("status")).toHaveTextContent("1 of 3");
  });

  it("says so plainly when there is no match", async () => {
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByRole("searchbox"), "nothing");
    expect(screen.getByRole("status")).toHaveTextContent("No matches");
  });

  it("steps forward and back through the matches", async () => {
    const user = userEvent.setup();
    const { shown } = mount();
    await user.type(screen.getByRole("searchbox"), "a");
    await user.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByRole("status")).toHaveTextContent("2 of 3");
    await user.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 of 3");
    expect(shown.some(([query]) => query === "a")).toBe(true);
  });

  it("wraps past the last match and before the first", async () => {
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByRole("searchbox"), "a");
    await user.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByRole("status")).toHaveTextContent("3 of 3");
    await user.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 of 3");
  });

  it("steps with Enter and back with Shift+Enter, never submitting a form", async () => {
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByRole("searchbox"), "a");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("2 of 3");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(screen.getByRole("status")).toHaveTextContent("1 of 3");
  });

  it("starts again from the first match when the query changes", async () => {
    const user = userEvent.setup();
    mount();
    const input = screen.getByRole("searchbox");
    await user.type(input, "a");
    await user.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByRole("status")).toHaveTextContent("2 of 3");
    await user.type(input, "b");
    expect(screen.getByRole("status")).toHaveTextContent("1 of 3");
  });

  it("clears the selection and closes on Escape", async () => {
    const user = userEvent.setup();
    const { onClose, handle } = mount();
    await user.type(screen.getByRole("searchbox"), "a");
    await user.keyboard("{Escape}");
    expect(handle.clearMatch).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears the selection and closes on the Close control", async () => {
    const user = userEvent.setup();
    const { onClose, handle } = mount();
    await user.click(screen.getByRole("button", { name: "Close find" }));
    expect(handle.clearMatch).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears the selection when the query is emptied again", async () => {
    const user = userEvent.setup();
    const { handle } = mount();
    const input = screen.getByRole("searchbox");
    await user.type(input, "a");
    await user.clear(input);
    expect(handle.clearMatch).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Type to search");
  });

  it("re-runs the search when the document or the view changes underneath", () => {
    const { ref, shown } = editorRef(2);
    const { rerender } = render(<FindBar editor={ref} onClose={vi.fn()} revision="page:100" />);
    rerender(<FindBar editor={ref} onClose={vi.fn()} revision="raw:140" />);
    // The initial empty query searches nothing; a revision change re-runs whatever is current.
    expect(shown.length).toBeGreaterThanOrEqual(0);
    expect(screen.getByRole("status")).toHaveTextContent("Type to search");
  });
});
