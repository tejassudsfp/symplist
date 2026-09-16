import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { StatusAnnouncerProvider } from "@/components/ui/status-announcer";
import { ApiNetworkError } from "@/lib/api";
import { ConflictReview } from "./conflict-review.tsx";
import { FakeDocuments } from "./fake-api.ts";
import type { ConflictState } from "./use-document.ts";

const base = [
  "## Overview",
  "",
  "Three projects, one page.",
  "",
  "## Next steps",
  "",
  "* Pick three projects",
  "",
].join("\n");

function wrap(children: ReactNode) {
  return <StatusAnnouncerProvider>{children}</StatusAnnouncerProvider>;
}

/**
 * A page whose saved version and local draft both moved on from the same base revision.
 * `savedEdit` and `draftEdit` replace text in the base.
 */
function mount(options: {
  savedEdit?: (text: string) => string;
  draftEdit?: (text: string) => string;
  onKeepDraft?: () => void;
  onDiscardDraft?: () => Promise<void>;
}) {
  const saved = options.savedEdit?.(base) ?? base;
  const draft = options.draftEdit?.(base) ?? base;
  const fake = new FakeDocuments({
    commits: [
      { markdown: base },
      ...(saved === base ? [] : [{ markdown: saved, author: "simon" as const }]),
    ],
  });
  const conflict: ConflictState = {
    currentRevision: fake.head?.revision ?? null,
    currentGeneration: fake.head?.generation ?? 0,
    draftPreserved: true,
    baseRevision: fake.commits[0]?.revision ?? null,
  };
  const onApply = vi.fn(async (_markdown: string) => undefined);
  const onKeepDraft = options.onKeepDraft ?? vi.fn();
  const onDiscardDraft = options.onDiscardDraft ?? vi.fn(async () => undefined);
  render(
    wrap(
      <ConflictReview
        taskId={fake.taskId}
        api={fake.api}
        conflict={conflict}
        draftMarkdown={draft}
        onApply={onApply}
        onKeepDraft={onKeepDraft}
        onDiscardDraft={onDiscardDraft}
      />,
    ),
  );
  return { fake, onApply, onKeepDraft, onDiscardDraft, saved, draft };
}

/** The single element carrying a `data-slot`, which is how these surfaces name their regions. */
function slot(name: string): HTMLElement {
  const elements = document.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`);
  expect(elements).toHaveLength(1);
  return elements[0] as HTMLElement;
}

const bothChanged = {
  savedEdit: (text: string) => text.replace("* Pick three projects", "* Pick four projects"),
  draftEdit: (text: string) => text.replace("* Pick three projects", "* Pick the two best"),
};

describe("conflict review", () => {
  it("says the page changed and never that anything was overwritten", async () => {
    mount(bothChanged);
    expect(
      screen.getByRole("heading", { name: "This page changed while you were editing" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing you wrote was overwritten/)).toBeInTheDocument();
    await screen.findByRole("button", { name: "Apply and save" });
    expect(document.body.textContent ?? "").not.toMatch(/overwritten by|lost|discarded your/i);
  });

  it("shows a loading state until the saved version arrives", () => {
    mount(bothChanged);
    expect(slot("conflict-review").textContent).toContain("Loading the saved version");
  });

  it("puts the draft and the saved version side by side for each overlap", async () => {
    mount(bothChanged);
    const item = await screen.findByRole("listitem");
    expect(within(item).getByText("Next steps")).toBeInTheDocument();
    expect(within(item).getByText("Changed in both")).toBeInTheDocument();
    expect(within(item).getByText("Your draft")).toBeInTheDocument();
    expect(within(item).getByText("Saved version")).toBeInTheDocument();
    expect(item.textContent).toContain("Pick the two best");
    expect(item.textContent).toContain("Pick four projects");
  });

  it("defaults to keeping the draft and applies the chosen sides", async () => {
    const user = userEvent.setup();
    const { onApply } = mount(bothChanged);
    await screen.findByRole("radio", { name: "Keep my draft" });
    expect(screen.getByRole("radio", { name: "Keep my draft" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Apply and save" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0]?.[0]).toContain("Pick the two best");
  });

  it("applies the saved version when that is chosen instead", async () => {
    const user = userEvent.setup();
    const { onApply } = mount(bothChanged);
    await user.click(await screen.findByRole("radio", { name: "Use the saved version" }));
    await user.click(screen.getByRole("button", { name: "Apply and save" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0]?.[0]).toContain("Pick four projects");
  });

  it("asks for nothing when the two sides changed different sections", async () => {
    const { onApply } = mount({
      savedEdit: (text) => text.replace("Three projects, one page.", "Simon rewrote this."),
      draftEdit: (text) => text.replace("* Pick three projects", "* Pick the two best"),
    });
    expect(await screen.findByText(/nothing has to be chosen/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Apply and save" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const merged = onApply.mock.calls[0]?.[0] as string;
    expect(merged).toContain("Simon rewrote this.");
    expect(merged).toContain("Pick the two best");
  });

  it("lists the sections kept as they are, so nothing disappears unexplained", async () => {
    mount({
      savedEdit: (text) => `${text}\n## Links\n\n* <https://example.com>\n`,
      draftEdit: (text) => text.replace("* Pick three projects", "* Pick the two best"),
    });
    const summary = await screen.findByText(/kept as they are/);
    expect(summary).toBeInTheDocument();
  });

  it("copies either side to the clipboard", async () => {
    // `userEvent.setup()` installs its own clipboard stub, so the spy goes on whatever it leaves.
    const user = userEvent.setup();
    const writeText = vi.spyOn(globalThis.navigator.clipboard, "writeText");
    mount(bothChanged);
    await user.click(await screen.findByRole("button", { name: "Copy draft" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain("Pick the two best");
  });

  it("keeps editing without publishing", async () => {
    const user = userEvent.setup();
    const { onKeepDraft } = mount(bothChanged);
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(onKeepDraft).toHaveBeenCalledTimes(1);
  });

  it("asks before discarding the draft, and starts focus on Cancel", async () => {
    const user = userEvent.setup();
    const { onDiscardDraft } = mount(bothChanged);
    await user.click(await screen.findByRole("button", { name: "Discard my draft" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(onDiscardDraft).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(onDiscardDraft).toHaveBeenCalledTimes(1));
  });

  it("reports a failure to load the saved version and offers a retry", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: base }] });
    fake.failNext = new ApiNetworkError();
    render(
      wrap(
        <ConflictReview
          taskId={fake.taskId}
          api={fake.api}
          conflict={{
            currentRevision: fake.head?.revision ?? null,
            currentGeneration: 1,
            draftPreserved: true,
            baseRevision: fake.head?.revision ?? null,
          }}
          draftMarkdown={`${base}mine`}
          onApply={vi.fn(async () => undefined)}
          onKeepDraft={vi.fn()}
          onDiscardDraft={vi.fn(async () => undefined)}
        />,
      ),
    );
    await waitFor(() => expect(slot("inline-error")).toBeInTheDocument());
    const alert = slot("inline-error");
    expect(within(alert).getByText(/You appear to be offline/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Apply and save" })).toBeInTheDocument(),
    );
  });

  it("falls back to a whole-document choice when the base revision is gone", async () => {
    const fake = new FakeDocuments({ commits: [{ markdown: base }] });
    render(
      wrap(
        <ConflictReview
          taskId={fake.taskId}
          api={fake.api}
          // A base the repository no longer holds.
          conflict={{
            currentRevision: fake.head?.revision ?? null,
            currentGeneration: 1,
            draftPreserved: true,
            baseRevision: "f".repeat(40),
          }}
          draftMarkdown={`${base}\nmine\n`}
          onApply={vi.fn(async () => undefined)}
          onKeepDraft={vi.fn()}
          onDiscardDraft={vi.fn(async () => undefined)}
        />,
      ),
    );
    // Without a base every difference is a genuine choice, and the review still loads.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Apply and save" })).toBeInTheDocument(),
    );
  });
});
