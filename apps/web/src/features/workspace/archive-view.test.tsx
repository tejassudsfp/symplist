import { screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveView } from "./archive-view.tsx";
import { FakeWorkspaceApi, findInlineError, renderWorkspace } from "./test-support.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/archive",
  push: vi.fn<(href: string) => void>(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: (href: string) => {
      navigation.push(href);
      navigation.pathname = href;
    },
    replace: vi.fn(),
    prefetch: () => undefined,
    back: () => undefined,
  }),
}));

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

/** A workspace with one completed parent (with a subtask) and one completed task of its own. */
async function archived() {
  const api = new FakeWorkspaceApi([
    { id: "portfolio", title: "Refresh my portfolio", collection: "later" },
    { id: "photos", title: "Choose portfolio photos", parentId: "portfolio" },
    { id: "bike", title: "Book a bike tune-up" },
  ]);
  await api.completeTask("portfolio", { mode: "all", stopRun: false });
  await api.completeTask("bike", { mode: "all", stopRun: false });
  api.calls.length = 0;
  return api;
}

beforeEach(() => {
  navigation.pathname = "/archive";
  navigation.push.mockClear();
});

/*
 * The archive (archive.md): completed tasks by the day they were completed, keeping their hierarchy,
 * with a calm Restore. The record's own page and conversation come from the shell's seams, so this
 * file covers the list, the search, the four states of the detail, and Restore with its result.
 */

describe("the archive", () => {
  it("groups completed tasks by day and keeps a subtask under its parent", async () => {
    renderWorkspace(<ArchiveView />, { api: await archived() });
    expect(screen.getByText("Loading the archive")).toBeInTheDocument();

    expect(await screen.findByRole("link", { name: /Refresh my portfolio/ })).toBeInTheDocument();
    const group = screen.getByRole("region", { name: "Today" });
    const titles = within(group)
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(titles).toEqual([
      "Refresh my portfolioLater",
      "Choose portfolio photosSubtask",
      "Book a bike tune-upNow",
    ]);
    // With no record open the detail pane invites one rather than showing an error.
    expect(screen.getByText("Pick a completed task")).toBeInTheDocument();
  });

  it("invites completing something when nothing is archived yet", async () => {
    renderWorkspace(<ArchiveView />, { api: new FakeWorkspaceApi() });
    expect(await screen.findByText("Nothing archived yet")).toBeInTheDocument();
    expect(screen.getByText(/ready to restore/)).toBeInTheDocument();
  });

  it("searches the archive and says so when nothing matches", async () => {
    const { user } = renderWorkspace(<ArchiveView />, { api: await archived() });
    await screen.findByRole("link", { name: /Refresh my portfolio/ });

    await user.type(screen.getByLabelText("Search the archive"), "bike");
    expect(await screen.findByRole("link", { name: /Book a bike tune-up/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /Refresh my portfolio/ })).not.toBeInTheDocument(),
    );

    await user.clear(screen.getByLabelText("Search the archive"));
    await user.type(screen.getByLabelText("Search the archive"), "kayak");
    expect(await screen.findByText(/Nothing in the archive matches “kayak”/)).toBeInTheDocument();
  });

  it("explains a failed load of the archive, and loads again", async () => {
    const api = await archived();
    api.fail("listArchive");
    const { user } = renderWorkspace(<ArchiveView />, { api });
    const alert = await findInlineError();
    expect(within(alert).getByText("Couldn't load the archive")).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: /Refresh my portfolio/ })).toBeInTheDocument();
  });

  it("restores a record with its subtasks, and offers to open it where it landed", async () => {
    const api = await archived();
    const { user } = renderWorkspace(<ArchiveView taskId="portfolio" />, { api });
    const detail = screen.getByRole("region", { name: "Archived task" });
    await within(detail).findByRole("heading", { name: "Refresh my portfolio" });
    expect(within(detail).getByText(/kept from Later/)).toBeInTheDocument();
    // A completed parent says what Restore will bring back before it is pressed.
    expect(
      within(detail).getByText("Restoring this task brings back the subtasks completed with it."),
    ).toBeInTheDocument();

    await user.click(within(detail).getByRole("button", { name: "Restore" }));
    expect(await within(detail).findByText(/Restored to Later with 1 subtask/)).toBeInTheDocument();
    expect(api.archivedIds()).not.toContain("portfolio");
    // Restore is gone once it has happened; the way on is to open the task.
    expect(within(detail).queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();

    await user.click(within(detail).getByRole("button", { name: "Open it" }));
    expect(navigation.push).toHaveBeenCalledWith("/later/portfolio");
  });

  it("changes nothing when a restore fails, and offers to try again", async () => {
    const api = await archived();
    api.fail("restoreTask");
    const { user } = renderWorkspace(<ArchiveView taskId="bike" />, { api });
    const detail = screen.getByRole("region", { name: "Archived task" });
    await within(detail).findByRole("heading", { name: "Book a bike tune-up" });

    await user.click(within(detail).getByRole("button", { name: "Restore" }));
    const alert = await findInlineError();
    expect(within(alert).getByText(/Couldn't restore this task/)).toBeInTheDocument();
    expect(
      within(alert).getByText("Nothing changed. Its page and conversation are still here."),
    ).toBeInTheDocument();
    expect(api.archivedIds()).toContain("bike");

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.archivedIds()).not.toContain("bike"));
  });

  it("says so calmly when the record is not in the archive any more", async () => {
    renderWorkspace(<ArchiveView taskId="gone" />, { api: await archived() });
    const detail = screen.getByRole("region", { name: "Archived task" });
    await waitFor(() =>
      expect(within(detail).getByText("This task isn't available")).toBeInTheDocument(),
    );
    expect(within(detail).getByText(/restored on another device/)).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });
});
