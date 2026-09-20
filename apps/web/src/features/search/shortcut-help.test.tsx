import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppAction } from "@/actions/types";
import { searchActions } from "./actions.ts";
import { CommandPalette } from "./command-palette.tsx";
import { bindingSearchKey, contextNotes, groupOf } from "./shortcut-help.tsx";
import { searchOverlay } from "./store.ts";
import { renderSearch, stubSearchApi } from "./test-support.tsx";

const navigation = vi.hoisted(() => ({ pathname: "/now", push: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: navigation.push,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

const nextTask: AppAction = {
  id: "workspace.next_task",
  label: "Next task",
  context: "pane",
  pane: "inbox",
  group: "tasks",
  defaultBinding: "j",
  allowRepeat: true,
  availability: () => ({ enabled: true }),
  run: vi.fn(),
};

const focusChat: AppAction = {
  id: "shell.focus_chat",
  label: "Open Simon chat",
  context: "app",
  group: "navigation",
  defaultBinding: "g c",
  availability: () => ({ enabled: false, reason: "Open a task first" }),
  run: vi.fn(),
};

const saveDocument: AppAction = {
  id: "documents.save",
  label: "Save page",
  context: "editor",
  defaultBinding: "mod+s",
  availability: () => ({ enabled: true }),
  run: vi.fn(),
};

const unbound: AppAction = {
  id: "simon.stop",
  label: "Stop Simon",
  context: "app",
  group: "chat",
  availability: () => ({ enabled: true }),
  run: vi.fn(),
};

const actions = [...searchActions, nextTask, focusChat, saveDocument, unbound];
const api = stubSearchApi({});

beforeEach(() => {
  navigation.push.mockClear();
});

afterEach(() => {
  act(() => searchOverlay.close());
  vi.unstubAllGlobals();
});

describe("shortcut grouping and notes", () => {
  it("puts an action in its own group, or the one its context implies", () => {
    expect(groupOf(nextTask)).toBe("tasks");
    expect(groupOf(saveDocument)).toBe("page");
    expect(groupOf({ ...saveDocument, context: "composer", group: undefined })).toBe("chat");
    expect(groupOf({ ...nextTask, group: undefined, pane: "page" })).toBe("page");
  });

  it("says where a shortcut applies and when it is inactive", () => {
    const caps = { steps: [[{ label: "J", spoken: "J" }]], display: "J", spoken: "J" };
    expect(contextNotes(nextTask, caps, undefined)).toEqual([
      "While the task list is focused",
      "Unavailable while typing",
    ]);
    const chord = {
      steps: [
        [
          { label: "⌘", spoken: "Command" },
          { label: "S", spoken: "S" },
        ],
      ],
      display: "⌘S",
      spoken: "Command S",
    };
    expect(contextNotes(saveDocument, chord, undefined)).toEqual(["In the page editor"]);
    expect(contextNotes(focusChat, caps, "Open a task first")).toContain("Open a task first");
  });

  it("normalizes typed bindings so cmd, ⌘ and control all find the same shortcut", () => {
    expect(bindingSearchKey("⌘K")).toBe("modk");
    expect(bindingSearchKey("Cmd + K")).toBe("modk");
    expect(bindingSearchKey("G then C")).toBe("gc");
    expect(bindingSearchKey("Control")).toBe("ctrl");
  });
});

describe("the shortcut help overlay", () => {
  it("opens with ?, groups the live registry and shows platform key caps", async () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "Win32", userAgent: "Windows" });
    const user = userEvent.setup({ delay: null });
    renderSearch(
      <>
        <button type="button">Task row</button>
        <CommandPalette />
      </>,
      { api, actions },
    );
    const row = screen.getByRole("button", { name: "Task row" });
    row.focus();
    await user.keyboard("?");

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const headings = within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["Navigation", "Tasks", "Page", "Search", "General"]);

    const palette = within(dialog).getByText("Search tasks and actions").closest("li");
    expect(palette).not.toBeNull();
    expect(within(palette as HTMLElement).getByText("Ctrl")).toBeInTheDocument();
    expect(within(palette as HTMLElement).getByText("Control K")).toBeInTheDocument();

    // A sequence is shown differently from a chord (keyboard_shortcuts.md).
    const chat = within(dialog).getByText("Open Simon chat").closest("li") as HTMLElement;
    expect(within(chat).getByText("then")).toBeInTheDocument();
    expect(chat.querySelector("[data-binding]")).toHaveAttribute("data-binding", "sequence");
    expect(chat).toHaveTextContent("Open a task first");
    const next = within(dialog).getByText("Next task").closest("li") as HTMLElement;
    expect(next).toHaveTextContent("While the task list is focused");
    expect(next).toHaveTextContent("Unavailable while typing");
    expect(next.querySelector("[data-binding]")).toHaveAttribute("data-binding", "chord");

    // Unbound actions stay in the palette rather than showing a decorative key cap.
    expect(within(dialog).queryByText("Stop Simon")).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(row).toHaveFocus());
  });

  it("shows macOS key names on a Mac", async () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel", userAgent: "Macintosh" });
    renderSearch(<CommandPalette />, { api, actions });
    act(() => searchOverlay.openHelp());
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const save = within(dialog).getByText("Save page").closest("li") as HTMLElement;
    expect(within(save).getByText("⌘")).toBeInTheDocument();
    expect(within(save).getByText("Command S")).toBeInTheDocument();
  });

  it("searches by action name and by binding, and says when nothing matches", async () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "Win32", userAgent: "Windows" });
    const user = userEvent.setup({ delay: null });
    renderSearch(<CommandPalette />, { api, actions });
    act(() => searchOverlay.openHelp());
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const search = within(dialog).getByRole("searchbox", {
      name: "Search shortcuts by action or keys",
    });

    await user.type(search, "next");
    expect(within(dialog).getByText("Next task")).toBeInTheDocument();
    expect(within(dialog).queryByText("Save page")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "g c");
    expect(within(dialog).getByText("Open Simon chat")).toBeInTheDocument();
    expect(within(dialog).queryByText("Next task")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "ctrl+k");
    expect(within(dialog).getByText("Search tasks and actions")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "zzz");
    expect(within(dialog).getByText("No shortcuts match “zzz”.")).toBeInTheDocument();
  });

  it("sends remapping to settings and closes on the way", async () => {
    const user = userEvent.setup({ delay: null });
    renderSearch(<CommandPalette />, { api, actions });
    act(() => searchOverlay.openHelp());
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await user.click(screen.getByRole("button", { name: "Change shortcuts" }));
    expect(navigation.push).toHaveBeenCalledWith("/settings/shortcuts");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
