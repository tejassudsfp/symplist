import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PANE_ATTRIBUTE } from "@/actions/focus";
import { WorkspaceDialogs } from "./dialogs.tsx";
import { TaskInbox } from "./task-inbox.tsx";
import { FakeWorkspaceApi, renderWorkspace } from "./test-support.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/now",
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

const PORTFOLIO = "0192b000-0000-7000-8000-000000000001";
const PICK = "0192b000-0000-7000-8000-000000000002";
const ABOUT = "0192b000-0000-7000-8000-000000000003";
const OUTLINE = "0192b000-0000-7000-8000-000000000004";
const BIKE = "0192b000-0000-7000-8000-000000000005";

function seeded() {
  return new FakeWorkspaceApi([
    { id: PORTFOLIO, title: "Refresh my portfolio" },
    { id: PICK, title: "Pick five projects to feature", parentId: PORTFOLIO },
    { id: ABOUT, title: "Rewrite the about page", parentId: PORTFOLIO },
    { id: OUTLINE, title: "Send the project outline" },
    { id: BIKE, title: "Book a bike tune-up" },
  ]);
}

/**
 * The list inside the shell's inbox pane. The workspace's actions are `context: "pane"`, so the
 * dispatcher only runs them when focus is inside an element marked as that pane — which is how the
 * shell scopes `j`/`k` to the list without stealing them from the chat or the page.
 */
async function listPane(api = seeded()) {
  const result = renderWorkspace(
    <div {...{ [PANE_ATTRIBUTE]: "inbox" }}>
      <TaskInbox collection="now" />
      <WorkspaceDialogs />
    </div>,
    { api },
  );
  await screen.findByText("Refresh my portfolio");
  return result;
}

const activeRow = () => document.activeElement?.closest('[role="treeitem"]')?.textContent ?? null;

beforeEach(() => {
  navigation.pathname = "/now";
  navigation.push.mockClear();
});

/*
 * The keyboard journey through the list (note 13, keyboard_shortcuts.md, §10.2). Every binding here
 * runs the same action a row, a menu or a button runs, so this file also covers the tree's own
 * roving tabindex: exactly one tab stop, and Tab leaves the tree instead of walking each control.
 */

describe("the list by keyboard alone", () => {
  it("moves down and up the visible rows with j and k", async () => {
    const { user } = await listPane();
    await user.click(screen.getByText("Refresh my portfolio"));

    await user.keyboard("j");
    await waitFor(() => expect(activeRow()).toContain("Send the project outline"));
    await user.keyboard("j");
    expect(activeRow()).toContain("Book a bike tune-up");
    await user.keyboard("k");
    expect(activeRow()).toContain("Send the project outline");
    // The list does not wrap past its ends.
    await user.keyboard("kk");
    expect(activeRow()).toContain("Refresh my portfolio");
  });

  it("opens and closes a sublist with the arrow keys, and walks into it", async () => {
    const { user } = await listPane();
    const row = screen.getByRole("treeitem", { name: /Refresh my portfolio/ });
    row.focus();

    await user.keyboard("{ArrowRight}");
    expect(await screen.findByText("Pick five projects to feature")).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(activeRow()).toContain("Pick five projects to feature"));

    // Collapsing from inside the sublist takes focus back to the parent, as a tree should.
    await user.keyboard("{ArrowUp}{ArrowLeft}");
    await waitFor(() =>
      expect(screen.queryByText("Pick five projects to feature")).not.toBeInTheDocument(),
    );
  });

  it("opens the focused task with Enter, so its page and chat switch together", async () => {
    const { user } = await listPane();
    screen.getByRole("treeitem", { name: /Send the project outline/ }).focus();
    await user.keyboard("{Enter}");
    expect(navigation.push).toHaveBeenCalledWith(`/now/${OUTLINE}`);
  });

  it("can be reached with Tab before anything in it has been focused", async () => {
    // A tree with no tabbable node is unreachable from the keyboard, so the first row holds the tab
    // stop until a row takes it (WAI-ARIA tree pattern).
    const { user } = await listPane();
    const tree = screen.getByRole("tree", { name: "Now tasks" });
    const rows = within(tree).getAllByRole("treeitem");
    expect(rows.filter((row) => row.tabIndex === 0)).toEqual([rows[0]]);

    for (let press = 0; press < 6 && !tree.contains(document.activeElement); press += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(rows[0]);
  });

  it("hands the tab stop back to the first row when the focused one is hidden", async () => {
    const { user } = await listPane();
    const tree = screen.getByRole("tree", { name: "Now tasks" });
    within(tree)
      .getByRole("treeitem", { name: /Book a bike tune-up/ })
      .focus();
    await waitFor(() =>
      expect(within(tree).getByRole("treeitem", { name: /Book a bike tune-up/ }).tabIndex).toBe(0),
    );

    await user.click(screen.getByRole("button", { name: "Search Now" }));
    await user.type(screen.getByLabelText("Search Now"), "outline");
    await waitFor(() => expect(screen.queryByText("Book a bike tune-up")).not.toBeInTheDocument());
    const shown = within(screen.getByRole("tree", { name: "Now tasks" })).getAllByRole("treeitem");
    expect(shown.filter((row) => row.tabIndex === 0)).toEqual([shown[0]]);
  });

  it("is one tab stop, so Tab leaves the tree instead of walking each row's controls", async () => {
    const { user } = await listPane();
    const tree = screen.getByRole("tree", { name: "Now tasks" });
    const rows = within(tree).getAllByRole("treeitem");
    rows[1]?.focus();

    // Exactly one row is tabbable, and it is the one with focus.
    await waitFor(() =>
      expect(
        within(tree)
          .getAllByRole("treeitem")
          .filter((row) => row.tabIndex === 0),
      ).toEqual([rows[1]]),
    );
    // Every control inside a row is reachable by pointer or action, never by Tab.
    for (const control of within(tree).getAllByRole("button")) {
      expect(control).toHaveAttribute("tabindex", "-1");
    }
    for (const control of within(tree).getAllByRole("checkbox")) {
      expect(control).toHaveAttribute("tabindex", "-1");
    }

    await user.tab();
    expect(tree.contains(document.activeElement)).toBe(false);
  });

  it("adds a task with n, renames with r and completes with x", async () => {
    const { user, api } = await listPane();
    screen.getByRole("treeitem", { name: /Book a bike tune-up/ }).focus();

    await user.keyboard("r");
    const field = await screen.findByLabelText("Rename Book a bike tune-up");
    await user.clear(field);
    await user.type(field, "Book the bike service{Enter}");
    expect(await screen.findByText("Book the bike service")).toBeInTheDocument();

    await user.keyboard("x");
    await waitFor(() => expect(api.archivedIds()).toContain(BIKE));

    await user.keyboard("n");
    await waitFor(() => expect(screen.getByLabelText("Add task to Now")).toHaveFocus());
    await user.keyboard("Water the plants{Enter}");
    await waitFor(() => expect(api.titles("now")).toContain("Water the plants"));
  });

  it("opens a sublist draft with Shift+N under the focused task", async () => {
    const { user, api } = await listPane();
    screen.getByRole("treeitem", { name: /Send the project outline/ }).focus();

    await user.keyboard("{Shift>}N{/Shift}");
    const field = await screen.findByLabelText("Add subtask under Send the project outline");
    await user.type(field, "Ask for the brief{Enter}");
    await waitFor(() => expect(api.titles("now")).toContain("  Ask for the brief"));
  });

  it("moves a task to another collection from the keyboard, with Undo", async () => {
    const { user, api } = await listPane();
    screen.getByRole("treeitem", { name: /Book a bike tune-up/ }).focus();

    await user.keyboard("m");
    await user.click(await screen.findByRole("menuitem", { name: "Later" }));
    await waitFor(() => expect(api.titles("later")).toContain("Book a bike tune-up"));

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.titles("now")).toContain("Book a bike tune-up"));
  });

  it("opens the focused task's menu with Shift+F10", async () => {
    const { user } = await listPane();
    screen.getByRole("treeitem", { name: /Book a bike tune-up/ }).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(await screen.findByRole("menuitem", { name: /Rename/ })).toBeInTheDocument();
  });

  it("leaves single-key shortcuts alone while the quick-add field has focus", async () => {
    const { user, api } = await listPane();
    const field = screen.getByLabelText("Add task to Now");
    await user.click(field);
    // `x` would complete a task if it fired here; typing must simply type.
    await user.type(field, "next week");
    expect(field).toHaveValue("next week");
    expect(api.archivedIds()).toEqual([]);
  });
});
