import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { WorkspaceDialogs } from "./dialogs.tsx";
import { TaskRunStateProvider, type TaskRunStateSource } from "./run-state.ts";
import { TaskInbox } from "./task-inbox.tsx";
import { FakeWorkspaceApi, renderWorkspace } from "./test-support.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/now",
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
    { id: "portfolio", title: "Refresh my portfolio", preview: "Five projects, one page" },
    { id: "pick", title: "Pick five projects to feature", parentId: "portfolio" },
    { id: "about", title: "Rewrite the about page", parentId: "portfolio" },
    { id: "outline", title: "Send the project outline" },
    { id: "bike", title: "Book a bike tune-up" },
    { id: "weekend", title: "Plan a quiet weekend", collection: "later" },
  ]);
}

function inbox(options: Parameters<typeof renderWorkspace>[1] = {}) {
  return renderWorkspace(
    <>
      <TaskInbox collection="now" />
      <WorkspaceDialogs />
    </>,
    options,
  );
}

async function loaded(api = seeded()) {
  const result = inbox({ api });
  await screen.findByText("Refresh my portfolio");
  return result;
}

beforeEach(() => {
  navigation.pathname = "/now";
  navigation.push.mockClear();
  navigation.replace.mockClear();
});

describe("the task list", () => {
  it("shows a loading state that never blocks capture", async () => {
    const api = seeded();
    inbox({ api });
    expect(screen.getByRole("status", { name: "" })).toBeInTheDocument();
    expect(screen.getByLabelText("Add task to Now")).toBeEnabled();
    await screen.findByText("Refresh my portfolio");
  });

  it("explains a failed load in place, and loads again on Try again", async () => {
    const api = seeded();
    api.fail("listTasks");
    inbox({ api });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Couldn't load Now")).toBeInTheDocument();
    await screen.getByRole("button", { name: "Try again" }).click();
    await screen.findByText("Refresh my portfolio");
  });

  it("invites a first task when the list is empty, in the collection's own words", async () => {
    renderWorkspace(<TaskInbox collection="unclassified" />, { api: new FakeWorkspaceApi() });
    expect(await screen.findByText("Drop a thought here")).toBeInTheDocument();
    expect(screen.getByText(/Sort it when you're ready/)).toBeInTheDocument();
  });

  it("adds a task with Enter, keeps meaningful text on blur and clears an empty draft on Escape", async () => {
    const { user, api } = await loaded();
    const field = screen.getByLabelText("Add task to Now");
    await user.type(field, "Water the plants{Enter}");
    expect(await screen.findByText("Water the plants")).toBeInTheDocument();
    expect(api.titles("now")).toContain("Water the plants");

    await user.type(field, "Half a thought");
    await user.tab();
    expect(screen.getByLabelText("Add task to Now")).toHaveValue("Half a thought");

    await user.clear(field);
    await user.type(field, "{Escape}");
    expect(screen.getByLabelText("Add task to Now")).toHaveValue("");
  });

  it("keeps the text and offers Try again when a task cannot be added", async () => {
    const { user, api } = await loaded();
    api.fail("createTask");
    await user.type(screen.getByLabelText("Add task to Now"), "Water the plants{Enter}");
    expect(await screen.findByText(/Couldn't add “Water the plants”/)).toBeInTheDocument();
    expect(screen.getByLabelText("Add task to Now")).toHaveValue("Water the plants");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Water the plants")).toBeInTheDocument();
  });

  it("opens and closes a sublist and shows how many subtasks are hidden", async () => {
    const { user } = await loaded();
    expect(screen.getByText("2 subtasks")).toBeInTheDocument();
    expect(screen.queryByText("Pick five projects to feature")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand Refresh my portfolio subtasks" }));
    expect(screen.getByText("Pick five projects to feature")).toBeInTheDocument();
    const row = screen.getByRole("treeitem", { name: /Refresh my portfolio/ });
    expect(row).toHaveAttribute("aria-expanded", "true");
    await user.click(
      screen.getByRole("button", { name: "Collapse Refresh my portfolio subtasks" }),
    );
    expect(screen.queryByText("Pick five projects to feature")).not.toBeInTheDocument();
  });

  it("adds a subtask under a task from its menu", async () => {
    const { user, api } = await loaded();
    await user.click(
      screen.getByRole("button", { name: "Task menu for Send the project outline" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Add subtask/ }));
    const field = await screen.findByLabelText("Add subtask under Send the project outline");
    await user.type(field, "Ask for the brief{Enter}");
    expect(await screen.findByText("Ask for the brief")).toBeInTheDocument();
    expect(api.titles("now")).toContain("  Ask for the brief");
  });

  it("renames a task inline, and keeps the text with Try again when the save fails", async () => {
    const { user, api } = await loaded();
    await user.click(screen.getByRole("button", { name: "Task menu for Book a bike tune-up" }));
    await user.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    const field = await screen.findByLabelText("Rename Book a bike tune-up");
    await user.clear(field);
    await user.type(field, "Book the bike service{Enter}");
    expect(await screen.findByText("Book the bike service")).toBeInTheDocument();

    api.fail("renameTask");
    await user.click(screen.getByRole("button", { name: "Task menu for Book the bike service" }));
    await user.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    const again = await screen.findByLabelText("Rename Book the bike service");
    await user.clear(again);
    await user.type(again, "Book the bike shop{Enter}");
    expect(await screen.findByText("Rename didn't save.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Book the bike shop")).toBeInTheDocument();
  });

  it("opens a task so its page and chat switch together", async () => {
    const { user } = await loaded();
    await user.click(screen.getByText("Send the project outline"));
    expect(navigation.push).toHaveBeenCalledWith("/now/outline");
  });

  it("completes a task without subtasks and offers Undo", async () => {
    const { user, api } = await loaded();
    await user.click(screen.getByRole("checkbox", { name: "Complete Book a bike tune-up" }));
    await waitFor(() => expect(screen.queryByText("Book a bike tune-up")).not.toBeInTheDocument());
    const toast = await screen.findByText(/Completed “Book a bike tune-up”/);
    expect(toast).toBeInTheDocument();
    expect(api.archivedIds()).toContain("bike");

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Book a bike tune-up")).toBeInTheDocument();
    expect(api.archivedIds()).not.toContain("bike");
  });

  it("asks before completing a parent, and can complete only the parent", async () => {
    const { user, api } = await loaded();
    await user.click(screen.getByRole("checkbox", { name: "Complete Refresh my portfolio" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Complete “Refresh my portfolio” and its 2 subtasks?"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Pick five projects to feature")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Only the parent" }));
    await waitFor(() => expect(api.archivedIds()).toEqual(["portfolio"]));
    expect(await screen.findByText("Pick five projects to feature")).toBeInTheDocument();
  });

  it("leaves everything alone when the confirmation is cancelled", async () => {
    const { user, api } = await loaded();
    await user.click(screen.getByRole("checkbox", { name: "Complete Refresh my portfolio" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.archivedIds()).toEqual([]);
    expect(screen.getByText("Refresh my portfolio")).toBeInTheDocument();
  });

  it("offers to stop Simon before completing a task he is working on", async () => {
    const api = seeded();
    const source: TaskRunStateSource = {
      get: (taskId) => ({ status: taskId === "outline" ? "running" : "idle" }),
      subscribe: () => () => undefined,
    };
    const { user } = renderWorkspace(
      <TaskRunStateProvider source={source}>
        <TaskInbox collection="now" />
        <WorkspaceDialogs />
      </TaskRunStateProvider>,
      { api },
    );
    await screen.findByText("Send the project outline");
    expect(screen.getByText("Simon is working")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Complete Send the project outline" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Stop Simon and complete this task?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Stop and complete" }));
    await waitFor(() => expect(api.archivedIds()).toContain("outline"));
    const completion = api.calls.find((call) => call.method === "completeTask");
    expect(completion?.detail).toMatchObject({ body: { stopRun: true } });
  });

  it("asks the same question when the server refuses because a run started", async () => {
    const { user, api } = await loaded();
    api.fail(
      "completeTask",
      new ApiError({
        status: 409,
        code: "task.run_active",
        message: "Simon is working",
        requestId: "req-test",
      }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Complete Book a bike tune-up" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Stop Simon and complete this task?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Stop and complete" }));
    await waitFor(() => expect(api.archivedIds()).toContain("bike"));
  });

  it("moves a task to another collection from its menu, with Undo", async () => {
    const { user, api } = await loaded();
    await user.click(screen.getByRole("button", { name: "Task menu for Book a bike tune-up" }));
    await user.click(await screen.findByRole("menuitem", { name: /Move to…/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Later" }));
    await waitFor(() => expect(api.titles("later")).toContain("Book a bike tune-up"));
    expect(await screen.findByText(/Moved “Book a bike tune-up” to Later/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.titles("now")).toContain("Book a bike tune-up"));
  });

  it("puts a task back where it was when a move fails, and offers Try again", async () => {
    const { user, api } = await loaded();
    api.fail("moveTask");
    await user.click(screen.getByRole("button", { name: "Task menu for Book a bike tune-up" }));
    await user.click(await screen.findByRole("menuitem", { name: /Move to…/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Unclassified" }));
    expect(
      await screen.findByText(/Couldn't move “Book a bike tune-up”.*back where it was/),
    ).toBeInTheDocument();
    expect(screen.getByText("Book a bike tune-up")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.titles("unclassified")).toContain("Book a bike tune-up"));
  });

  it("filters the list and says so when nothing matches", async () => {
    const { user } = await loaded();
    await user.click(screen.getByRole("button", { name: "Search Now" }));
    const field = await screen.findByLabelText("Search Now");
    await user.type(field, "bike");
    expect(screen.getByText("Book a bike tune-up")).toBeInTheDocument();
    expect(screen.queryByText("Send the project outline")).not.toBeInTheDocument();

    await user.clear(field);
    await user.type(field, "kayak");
    expect(screen.getByText("No tasks in Now match “kayak”.")).toBeInTheDocument();
  });

  it("shows a task's preview and where it came from", async () => {
    const api = seeded();
    api.seed({ id: "agent", title: "Review the outline", source: "mcp" });
    await loaded(api);
    expect(screen.getByText("Five projects, one page")).toBeInTheDocument();
    expect(await screen.findByText("Added by connected agent")).toBeInTheDocument();
  });
});
