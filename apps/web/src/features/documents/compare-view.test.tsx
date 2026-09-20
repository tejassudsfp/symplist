import type { DocumentCompareResponse } from "@symplist/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompareView } from "./compare-view.tsx";

const base = "a".repeat(40);
const target = "b".repeat(40);

function comparison(overrides: Partial<DocumentCompareResponse> = {}): DocumentCompareResponse {
  return {
    taskId: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a",
    baseRevision: base,
    targetRevision: target,
    headRevision: target,
    commitsBetween: 0,
    changes: [],
    hunks: [],
    nextCursor: null,
    ...overrides,
  } as DocumentCompareResponse;
}

const change = (
  status: "added" | "modified" | "removed",
  heading: string | null,
  kind: "heading" | "preamble" | "block" = "heading",
) =>
  ({
    status,
    sectionId: status === "removed" ? null : `s${"a".repeat(25)}`,
    baselineSectionId: status === "added" ? null : `s${"b".repeat(25)}`,
    kind,
    depth: 2,
    heading,
    bytes: 20,
  }) as DocumentCompareResponse["changes"][number];

const hunk = (overrides: Partial<DocumentCompareResponse["hunks"][number]> = {}) =>
  ({
    baseStart: 5,
    baseLines: 2,
    targetStart: 5,
    targetLines: 3,
    truncated: false,
    lines: [
      { kind: "context", text: "## Next steps", baseLine: 5, targetLine: 5 },
      { kind: "removed", text: "* Pick three projects", baseLine: 6, targetLine: null },
      { kind: "added", text: "* Pick four projects", baseLine: null, targetLine: 6 },
    ],
    ...overrides,
  }) as DocumentCompareResponse["hunks"][number];

describe("the comparison with the current version", () => {
  it("summarises what changed in words", () => {
    render(
      <CompareView
        comparison={comparison({
          changes: [change("added", "Links"), change("modified", "Next steps")],
        })}
      />,
    );
    expect(screen.getByText(/1 added, 1 changed/)).toBeInTheDocument();
  });

  it("labels every changed section with a word, never colour alone", () => {
    render(
      <CompareView
        comparison={comparison({
          changes: [
            change("added", "Links"),
            change("modified", "Next steps"),
            change("removed", "Old plan"),
          ],
        })}
      />,
    );
    const list = screen.getByRole("list");
    for (const [label, name] of [
      ["Added", "Links"],
      ["Changed", "Next steps"],
      ["Removed", "Old plan"],
    ]) {
      expect(within(list).getByText(label as string)).toBeInTheDocument();
      expect(within(list).getByText(name as string)).toBeInTheDocument();
    }
  });

  it("names a heading-free section in words rather than showing an id", () => {
    render(
      <CompareView comparison={comparison({ changes: [change("modified", null, "preamble")] })} />,
    );
    expect(screen.getByText("Opening text")).toBeInTheDocument();
    expect(screen.queryByText(/^s[a-z]{25}$/)).toBeNull();
  });

  it("says plainly when the two revisions hold the same text", () => {
    render(<CompareView comparison={comparison({ commitsBetween: 3 })} />);
    expect(screen.getByText(/hold the same text/)).toBeInTheDocument();
    expect(screen.getByText(/3 revisions in between/)).toBeInTheDocument();
  });

  it("counts a single revision in between in the singular", () => {
    render(<CompareView comparison={comparison({ commitsBetween: 1 })} />);
    expect(screen.getByText(/1 revision in between/)).toBeInTheDocument();
  });

  it("marks every diff line with a symbol and a screen-reader label", () => {
    render(
      <CompareView
        comparison={comparison({ changes: [change("modified", "Next steps")], hunks: [hunk()] })}
      />,
    );
    const lines = screen.getAllByRole("listitem").filter((item) => item.dataset.kind);
    expect(lines).toHaveLength(3);
    const [context, removed, added] = lines as [HTMLElement, HTMLElement, HTMLElement];
    expect(context).toHaveAttribute("data-kind", "context");
    expect(removed).toHaveTextContent("−");
    expect(within(removed).getByText("Removed:")).toBeInTheDocument();
    expect(added).toHaveTextContent("+");
    expect(within(added).getByText("Added:")).toBeInTheDocument();
    // A context line carries no label, so nothing is announced twice.
    expect(within(context).queryByText(/Added:|Removed:/)).toBeNull();
  });

  it("says where in each revision a block of lines sits", () => {
    render(<CompareView comparison={comparison({ hunks: [hunk()] })} />);
    expect(screen.getByText(/Lines 5–6 in the chosen revision, 5–7 now/)).toBeInTheDocument();
  });

  it("says when a block was shortened rather than dropping it silently", () => {
    render(<CompareView comparison={comparison({ hunks: [hunk({ truncated: true })] })} />);
    expect(screen.getByText(/shortened to keep the page quick/)).toBeInTheDocument();
  });

  it("offers more differences only when there are more", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <CompareView comparison={comparison({ hunks: [hunk()] })} onLoadMore={onLoadMore} />,
    );
    await user.click(screen.getByRole("button", { name: "Show more differences" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(<CompareView comparison={comparison({ hunks: [hunk()] })} />);
    expect(screen.queryByRole("button", { name: "Show more differences" })).toBeNull();
  });

  it("reports progress and cannot repeat while more differences load", () => {
    render(
      <CompareView comparison={comparison({ hunks: [hunk()] })} onLoadMore={vi.fn()} loadingMore />,
    );
    const button = screen.getByRole("button", { name: "Loading…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("keeps the commit ids as a secondary technical detail, not as a name", () => {
    render(<CompareView comparison={comparison()} />);
    expect(screen.getByText(/Revision aaaaaaa compared with bbbbbbb/)).toBeInTheDocument();
  });

  it("shows no repository concepts the brief rules out", () => {
    render(
      <CompareView
        comparison={comparison({ changes: [change("modified", "Next steps")], hunks: [hunk()] })}
      />,
    );
    expect(document.body.textContent ?? "").not.toMatch(/branch|staging|pull request|commit\b/i);
  });
});
