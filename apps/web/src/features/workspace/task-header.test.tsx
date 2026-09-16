import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceDialogs } from "./dialogs.tsx";
import type { TaskRunStateSource } from "./run-state.ts";
import { ChatTitle, TaskHeader } from "./task-header.tsx";
import { FakeWorkspaceApi, renderWorkspace } from "./test-support.tsx";

/** Task ids have to be real UUIDs: the shell only reads a task out of the address when it is one. */
const PORTFOLIO = "0192a000-0000-7000-8000-000000000001";
const PHOTOS = "0192a000-0000-7000-8000-000000000002";
const OUTLINE = "0192a000-0000-7000-8000-000000000003";

const navigation = vi.hoisted(() => ({
  pathname: "/now/0192a000-0000-7000-8000-000000000003",
  push: vi.fn<(href: string) => void>(),
  replace: vi.fn<(href: string) => void>(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: (href: string) => {
      navigation.push(href);
      navigation.pathname = href;
    },
    replace: (href: string) => {
      navigation.replace(href);
      navigation.pathname = href;
    },
    prefetch: () => undefined,
    back: () => undefined,
  }),
}));

function seeded() {
  return new FakeWorkspaceApi([
    { id: PORTFOLIO, title: "Refresh my portfolio", collection: "later" },
    { id: PHOTOS, title: "Choose portfolio photos", parentId: PORTFOLIO },
    { id: OUTLINE, title: "Send the project outline" },
  ]);
}

beforeEach(() => {
  navigation.pathname = `/now/${OUTLINE}`;
  navigation.push.mockClear();
  navigation.replace.mockClear();
});

/*
 * The task page header and the chat's subtitle (task_document.md, workspace_now.md): the states the
 * shell's page frame can be in while the task behind it is loading, missing, nested or archived.
 */

describe("the task page header", () => {
  it("waits without a title, then shows the task with its collection", async () => {
    renderWorkspace(<TaskHeader taskId={OUTLINE} />, { api: seeded() });
    expect(screen.getByText("Loading this task")).toBeInTheDocument();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Send the project outline" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Now")).toBeInTheDocument();
    expect(screen.getByLabelText("Complete Send the project outline")).toBeEnabled();
  });

  it("names the parent a subtask sits under", async () => {
    navigation.pathname = `/later/${PHOTOS}`;
    renderWorkspace(<TaskHeader taskId={PHOTOS} />, { api: seeded() });
    await screen.findByRole("heading", { name: "Choose portfolio photos" });
    expect(screen.getByText("in “Refresh my portfolio”")).toBeInTheDocument();
    expect(screen.getByText("Later")).toBeInTheDocument();
  });

  it("says so calmly when the task is not there any more", async () => {
    renderWorkspace(<TaskHeader taskId="gone" />, { api: seeded() });
    expect(await screen.findByText("This task isn't available")).toBeInTheDocument();
    expect(screen.getByText("Pick another task from the list")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("keeps the address honest when the task is in another collection", async () => {
    // The address says Now; the task is in Later, as a move on another device would leave it.
    navigation.pathname = `/now/${PORTFOLIO}`;
    renderWorkspace(<TaskHeader taskId={PORTFOLIO} />, { api: seeded() });
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(`/later/${PORTFOLIO}`));
  });

  it("shows an archived task as read only, with no completion and no menu", async () => {
    const api = seeded();
    await api.completeTask(OUTLINE, { mode: "all", stopRun: false });
    renderWorkspace(<TaskHeader taskId={OUTLINE} />, { api });
    expect(await screen.findByText("Archived from Now")).toBeInTheDocument();
    expect(screen.queryByLabelText("Complete Send the project outline")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Task menu for Send the project outline/ }),
    ).not.toBeInTheDocument();
  });

  it("shows that Simon is working, in words and not colour alone", async () => {
    const source: TaskRunStateSource = {
      get: (taskId) => ({ status: taskId === OUTLINE ? "awaiting_approval" : "idle" }),
      subscribe: () => () => undefined,
    };
    renderWorkspace(<TaskHeader taskId={OUTLINE} />, { api: seeded(), runState: source });
    await screen.findByRole("heading", { name: "Send the project outline" });
    expect(screen.getByText("Waiting for your approval")).toBeInTheDocument();
  });

  it("completes the open task from the header and leaves the task's address", async () => {
    const api = seeded();
    const { user } = renderWorkspace(
      <>
        <TaskHeader taskId={OUTLINE} />
        <WorkspaceDialogs />
      </>,
      { api },
    );
    await screen.findByRole("heading", { name: "Send the project outline" });

    await user.click(screen.getByLabelText("Complete Send the project outline"));
    await waitFor(() => expect(api.archivedIds()).toContain(OUTLINE));
    // The completed task's page is gone, so the address falls back to the list it came from.
    expect(navigation.push).toHaveBeenCalledWith("/now");
  });

  it("asks before archiving a parent's subtasks, with no list loaded behind it", async () => {
    // The header can be the only surface a task is open on (a direct link, the list still loading),
    // and the subtasks must never go quietly then either (decision P1).
    navigation.pathname = `/later/${PORTFOLIO}`;
    const api = seeded();
    const { user } = renderWorkspace(
      <>
        <TaskHeader taskId={PORTFOLIO} />
        <WorkspaceDialogs />
      </>,
      { api },
    );
    await screen.findByRole("heading", { name: "Refresh my portfolio" });

    await user.click(screen.getByLabelText("Complete Refresh my portfolio"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Complete “Refresh my portfolio” and its subtasks?"),
    ).toBeInTheDocument();
    expect(api.archivedIds()).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Only the parent" }));
    await waitFor(() => expect(api.archivedIds()).toEqual([PORTFOLIO]));
  });

  it("renames from the header and keeps the text when the save fails", async () => {
    const api = seeded();
    const { user } = renderWorkspace(<TaskHeader taskId={OUTLINE} />, { api });
    await screen.findByRole("heading", { name: "Send the project outline" });

    await user.click(
      screen.getByRole("button", { name: /Task menu for Send the project outline/ }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    const field = await screen.findByLabelText("Rename Send the project outline");
    await user.clear(field);
    await user.type(field, "Send the brief{Enter}");
    expect(await screen.findByRole("heading", { name: "Send the brief" })).toBeInTheDocument();

    api.fail("renameTask");
    await user.click(screen.getByRole("button", { name: /Task menu for Send the brief/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    const again = await screen.findByLabelText("Rename Send the brief");
    await user.clear(again);
    await user.type(again, "Send the outline{Enter}");
    // The header's own message, not the status announcer's permanently mounted assertive region.
    const alert = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".sym-task-error");
      if (!node) throw new Error("no rename message yet");
      return node;
    });
    expect(alert).toHaveAttribute("role", "alert");
    expect(within(alert).getByText("Rename didn't save.")).toBeInTheDocument();
    expect(again).toHaveValue("Send the outline");
  });
});

describe("the chat subtitle", () => {
  it("names the task the conversation belongs to, and nothing before it is known", async () => {
    renderWorkspace(<ChatTitle taskId={OUTLINE} />, { api: seeded() });
    expect(await screen.findByText("Send the project outline")).toBeInTheDocument();
  });

  it("stays out of the way when the task cannot be read", async () => {
    renderWorkspace(<ChatTitle taskId="gone" />, { api: seeded() });
    // Nothing is rendered at all rather than an empty subtitle or a placeholder.
    await waitFor(() => expect(document.querySelector(".truncate")).toBeNull());
    expect(screen.queryByText("Send the project outline")).not.toBeInTheDocument();
  });
});
