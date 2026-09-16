import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { StatusAnnouncerProvider } from "@/components/ui/status-announcer";
import { ApiError, ApiNetworkError } from "@/lib/api";
import { FakeDocuments } from "./fake-api.ts";
import { DocumentHistoryScreen, HISTORY_PAGE_SIZE } from "./history-screen.tsx";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const taskId = "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a";
const now = 1_758_000_000_000;

const v1 = "## Overview\n\nThe first draft.\n";
const v2 = "## Overview\n\nThe first draft.\n\n## Next steps\n\n* Pick three projects\n";
const v3 = "## Overview\n\nA clearer overview.\n\n## Next steps\n\n* Pick three projects\n";

function slot(name: string): HTMLElement {
  const elements = document.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`);
  expect(elements).toHaveLength(1);
  return elements[0] as HTMLElement;
}

function mount(fake: FakeDocuments, from?: string | null) {
  render(
    <StatusAnnouncerProvider>
      <DocumentHistoryScreen
        taskId={fake.taskId}
        from={from ?? null}
        api={fake.api}
        now={() => now}
      />
    </StatusAnnouncerProvider>,
  );
  return fake;
}

function threeVersions(): FakeDocuments {
  return new FakeDocuments({
    taskId,
    now: () => now,
    commits: [
      { markdown: v1, committedAt: now - 3 * 3_600_000 },
      { markdown: v2, author: "simon", committedAt: now - 2 * 3_600_000 },
      { markdown: v3, committedAt: now - 60_000 },
    ],
  });
}

async function openOldest() {
  const user = userEvent.setup();
  const rows = await screen.findAllByRole("button", { name: /You,|Simon,/ });
  await user.click(rows.at(-1) as HTMLElement);
  return user;
}

describe("the revision list", () => {
  it("shows a loading state, then the revisions", async () => {
    mount(threeVersions());
    expect(screen.getByText("Loading revisions")).toBeInTheDocument();
    expect(await screen.findByText("Created the page")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /You,|Simon,/ })).toHaveLength(3);
  });

  it("names the actor, the relative time and what changed", async () => {
    mount(threeVersions());
    const rows = await screen.findAllByRole("button", { name: /You,|Simon,/ });
    const newest = rows[0] as HTMLElement;
    expect(newest).toHaveAccessibleName("You, 1 minute ago: Updated Overview");
    expect(within(newest).getByText("Current")).toBeInTheDocument();
  });

  it("keeps the exact time available behind the relative one", async () => {
    mount(threeVersions());
    await screen.findByText("Created the page");
    const times = screen.getAllByText(/ago|just now/);
    for (const time of times) {
      expect(time).toHaveAttribute("title");
      expect(time).toHaveAttribute("datetime");
    }
  });

  it("groups a sitting by one author and names who it was", async () => {
    mount(threeVersions());
    await screen.findByText("Created the page");
    expect(screen.getAllByText("Simon")).not.toHaveLength(0);
    expect(screen.getAllByText("You")).not.toHaveLength(0);
  });

  it("says so plainly when the page has no previous versions", async () => {
    mount(new FakeDocuments({ taskId, now: () => now }));
    expect(await screen.findByText("No previous versions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /You,/ })).toBeNull();
  });

  it("reports a load failure in plain language and retries", async () => {
    const fake = threeVersions();
    fake.failNext = new ApiNetworkError();
    mount(fake);
    await waitFor(() => expect(slot("inline-error")).toBeInTheDocument());
    expect(within(slot("inline-error")).getByText(/You appear to be offline/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(slot("inline-error")).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Created the page")).toBeInTheDocument();
  });

  it("pages through older revisions", async () => {
    const many = new FakeDocuments({
      taskId,
      now: () => now,
      commits: Array.from({ length: HISTORY_PAGE_SIZE + 4 }, (_, index) => ({
        markdown: `# Page\n\nversion ${index}\n`,
        committedAt: now - (HISTORY_PAGE_SIZE + 4 - index) * 3_600_000,
      })),
    });
    mount(many);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /You,/ })).toHaveLength(HISTORY_PAGE_SIZE),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show older revisions" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /You,/ })).toHaveLength(HISTORY_PAGE_SIZE + 4),
    );
  });

  it("says how page revisions relate to chat, as the brief asks", async () => {
    mount(threeVersions());
    expect(
      await screen.findByText(/Chat messages stay in the task's conversation/),
    ).toBeInTheDocument();
  });
});

describe("Back to page", () => {
  it("returns exactly to the task page it was entered from", async () => {
    mount(threeVersions(), `/later/${taskId}`);
    expect(screen.getByRole("link", { name: /Back to page/ })).toHaveAttribute(
      "href",
      `/later/${taskId}`,
    );
  });

  it("falls back to Now for a missing or hostile entry page", () => {
    const { unmount } = render(
      <StatusAnnouncerProvider>
        <DocumentHistoryScreen
          taskId={taskId}
          from="https://evil.example"
          api={threeVersions().api}
        />
      </StatusAnnouncerProvider>,
    );
    expect(screen.getByRole("link", { name: /Back to page/ })).toHaveAttribute(
      "href",
      `/now/${taskId}`,
    );
    unmount();
  });
});

describe("the revision preview", () => {
  it("invites a selection before one is made", async () => {
    mount(threeVersions());
    expect(await screen.findByText("Select a revision")).toBeInTheDocument();
  });

  it("shows the chosen revision's text and what changed since", async () => {
    mount(threeVersions());
    await openOldest();
    const preview = await waitFor(() => slot("revision-preview"));
    expect(preview.textContent).toContain("The first draft.");
    await waitFor(() => expect(slot("compare-view")).toBeInTheDocument());
    expect(within(slot("compare-view")).getByText("Added")).toBeInTheDocument();
  });

  it("keeps the technical commit id as a secondary detail", async () => {
    mount(threeVersions());
    await openOldest();
    expect(await screen.findByText(/^Revision [0-9a-f]{7}$/)).toBeInTheDocument();
  });

  it("does not offer Restore on the version the page already shows", async () => {
    mount(threeVersions());
    const user = userEvent.setup();
    const rows = await screen.findAllByRole("button", { name: /You,/ });
    await user.click(rows[0] as HTMLElement);
    expect(await screen.findByText("This is the version the page shows now.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore this version" })).toBeNull();
  });

  it("reports a failure to load one revision without losing the list", async () => {
    const fake = threeVersions();
    mount(fake);
    const rows = await screen.findAllByRole("button", { name: /You,|Simon,/ });
    fake.failNext = new ApiNetworkError();
    const user = userEvent.setup();
    await user.click(rows.at(-1) as HTMLElement);
    await waitFor(() => expect(slot("inline-error")).toBeInTheDocument());
    expect(screen.getByText("Created the page")).toBeInTheDocument();
  });
});

describe("restoring", () => {
  it("confirms first, explaining that history is preserved", async () => {
    const fake = threeVersions();
    mount(fake);
    const user = await openOldest();
    await user.click(await screen.findByRole("button", { name: "Restore this version" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/adds a new current revision/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing is deleted/)).toBeInTheDocument();
    expect(fake.commits).toHaveLength(3);
  });

  it("creates a new current revision and keeps every earlier one", async () => {
    const fake = threeVersions();
    mount(fake);
    const user = await openOldest();
    await user.click(await screen.findByRole("button", { name: "Restore this version" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Restore" }),
    );
    await waitFor(() => expect(slot("restored")).toBeInTheDocument());
    expect(slot("restored").textContent).toMatch(/every earlier revision is kept/);
    expect(fake.commits).toHaveLength(4);
    expect(fake.head?.kind).toBe("restore");
    expect(fake.markdown).toBe(v1);
  });

  it("never discards fresh edits: a page that moved on is a restore conflict", async () => {
    const fake = threeVersions();
    mount(fake);
    const user = await openOldest();
    const restore = await screen.findByRole("button", { name: "Restore this version" });
    // Someone publishes while the preview is on screen.
    fake.publishElsewhere("## Overview\n\nSimon's newest text.\n");
    await user.click(restore);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Restore" }),
    );
    await waitFor(() => expect(slot("restore-conflict")).toBeInTheDocument());
    const notice = slot("restore-conflict");
    expect(notice.textContent).toMatch(/Nothing was restored and no newer edit was discarded/);
    expect(fake.markdown).toBe("## Overview\n\nSimon's newest text.\n");
  });

  it("reloads and previews again after a restore conflict", async () => {
    const fake = threeVersions();
    mount(fake);
    const user = await openOldest();
    const restore = await screen.findByRole("button", { name: "Restore this version" });
    fake.publishElsewhere("## Overview\n\nSimon's newest text.\n");
    await user.click(restore);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Restore" }),
    );
    await waitFor(() => expect(slot("restore-conflict")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Reload and preview again" }));
    await waitFor(() =>
      expect(document.querySelector('[data-slot="restore-conflict"]')).toBeNull(),
    );
    expect(screen.getAllByRole("button", { name: /You,|Simon,/ })).toHaveLength(4);
  });

  it("reports a failed restore without claiming anything happened", async () => {
    const fake = threeVersions();
    mount(fake);
    const user = await openOldest();
    await user.click(await screen.findByRole("button", { name: "Restore this version" }));
    fake.failNext = new ApiError({
      status: 500,
      code: "service.unavailable",
      message: "internal",
      requestId: "r",
    });
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Restore" }),
    );
    await waitFor(() => expect(slot("inline-error")).toBeInTheDocument());
    expect(document.querySelector('[data-slot="restored"]')).toBeNull();
    expect(fake.commits).toHaveLength(3);
  });

  it("does nothing when the confirmation is dismissed", async () => {
    const fake = threeVersions();
    mount(fake);
    const user = await openOldest();
    await user.click(await screen.findByRole("button", { name: "Restore this version" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.commits).toHaveLength(3);
  });
});

describe("the phone layout", () => {
  it("moves between the list and the preview as two screens", async () => {
    mount(threeVersions());
    const screenRoot = slot("history-screen");
    expect(screenRoot).toHaveAttribute("data-screen", "list");
    await openOldest();
    await waitFor(() => expect(screenRoot).toHaveAttribute("data-screen", "detail"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back to revisions" }));
    expect(screenRoot).toHaveAttribute("data-screen", "list");
  });

  it("returns to the list on Escape", async () => {
    mount(threeVersions());
    const screenRoot = slot("history-screen");
    await openOldest();
    await waitFor(() => expect(screenRoot).toHaveAttribute("data-screen", "detail"));
    const detail = screen.getByRole("region", { name: "Revision preview" });
    detail.focus();
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    expect(screenRoot).toHaveAttribute("data-screen", "list");
  });
});
