import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppAction } from "@/actions/types";
import { ApiError, ApiNetworkError } from "@/lib/api";
import { searchActions } from "./actions.ts";
import type { TaskLocation } from "./api.ts";
import { CommandPalette } from "./command-palette.tsx";
import { forgetSearchScreen, recallSearchScreen, searchOverlay } from "./store.ts";
import {
  lockedSession,
  mayaSession,
  renderSearch,
  signedOutSession,
  stubSearchApi,
  titleResponse,
  titleResult,
} from "./test-support.tsx";

const navigation = vi.hoisted(() => ({
  pathname: "/now",
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: navigation.push,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

const recentTasks: readonly TaskLocation[] = [
  {
    id: "0192f0a0-0000-7000-8000-000000000101",
    title: "Refresh my portfolio",
    collection: "now",
    archived: false,
    parentTitle: null,
  },
  {
    id: "0192f0a0-0000-7000-8000-000000000102",
    title: "Pick five projects to feature",
    collection: "now",
    archived: false,
    parentTitle: "Refresh my portfolio",
  },
];

/** Registry actions the palette lists in Actions mode, plus the search feature's own. */
const focusChat: AppAction = {
  id: "shell.focus_chat",
  label: "Open Simon chat",
  context: "app",
  group: "navigation",
  keywords: ["simon", "assistant"],
  defaultBinding: "g c",
  availability: ({ services }) =>
    services.route?.taskId ? { enabled: true } : { enabled: false, reason: "Open a task first" },
  run: vi.fn(),
};

const completeTask: AppAction = {
  id: "workspace.complete_task",
  label: "Complete task",
  context: "pane",
  pane: "inbox",
  group: "tasks",
  defaultBinding: "x",
  availability: () => ({ enabled: true }),
  run: vi.fn(),
};

const actions = [...searchActions, focusChat, completeTask];

function openPalette() {
  act(() => {
    searchOverlay.openPalette();
  });
}

beforeEach(() => {
  navigation.pathname = "/now";
  navigation.push.mockClear();
  (focusChat.run as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  act(() => {
    searchOverlay.close();
  });
  forgetSearchScreen();
});

describe("the command palette", () => {
  it("opens with Mod+K, shows recent tasks, and returns focus on Escape", async () => {
    const user = userEvent.setup({ delay: null });
    const api = stubSearchApi({ recentTasks: () => Promise.resolve(recentTasks) });
    renderSearch(
      <>
        <button type="button">Task row</button>
        <CommandPalette />
      </>,
      { api, actions },
    );
    const row = screen.getByRole("button", { name: "Task row" });
    row.focus();
    await user.keyboard("{Control>}k{/Control}");

    const input = await screen.findByRole("combobox", { name: "Search tasks" });
    await waitFor(() => expect(input).toHaveFocus());
    const listbox = screen.getByRole("listbox", { name: "Tasks" });
    expect(within(listbox).getByText("Recent tasks")).toBeInTheDocument();
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("Refresh my portfolio");
    expect(options[0]).toHaveTextContent("Now");
    expect(options[1]).toHaveTextContent("in “Refresh my portfolio”");
    expect(options.at(-1)).toHaveTextContent("Search all content");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
    await waitFor(() => expect(row).toHaveFocus());
  });

  it("finds tasks by title, ignores superseded responses and opens the active result", async () => {
    const user = userEvent.setup({ delay: null });
    const seen: string[] = [];
    const api = stubSearchApi({
      recentTasks: () => Promise.resolve([]),
      titles: async (q, _options, signal) => {
        seen.push(q);
        if (q === "por") {
          // A slow, superseded response must never replace the newer one.
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (signal?.aborted) throw new DOMException("aborted", "AbortError");
          return titleResponse([titleResult("Book a bike tune-up")]);
        }
        return titleResponse([
          titleResult("Refresh my portfolio", {
            task: {
              ...titleResult("Refresh my portfolio").task,
              titleHighlights: [{ start: 11, end: 20 }],
            },
            match: "title_prefix",
          }),
          titleResult("Choose portfolio photos", { match: "title_typo" }),
        ]);
      },
    });
    renderSearch(<CommandPalette />, { api, actions });
    openPalette();
    const input = await screen.findByRole("combobox", { name: "Search tasks" });
    await user.type(input, "por");
    await user.type(input, "tfolio");

    await screen.findByRole("option", { name: /Refresh my portfolio/ });
    const results = screen.getAllByRole("option");
    expect(results[0]).toHaveTextContent("Refresh my portfolio");
    expect(
      within(results[0] as HTMLElement).getByText("portfolio", { selector: "mark" }),
    ).toBeInTheDocument();
    expect(results[1]).toHaveTextContent("Similar spelling");
    expect(seen.at(-1)).toBe("portfolio");

    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{Enter}");
    await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/now/0192f0a0-0000-7000-8000-000000000101"),
    );
  });

  it("says when nothing matches, which is not a failure", async () => {
    const user = userEvent.setup({ delay: null });
    const api = stubSearchApi({
      recentTasks: () => Promise.resolve([]),
      titles: () => Promise.resolve(titleResponse([])),
    });
    renderSearch(<CommandPalette />, { api, actions });
    openPalette();
    await user.type(await screen.findByRole("combobox"), "kayak");
    expect(await screen.findByText("No task titles match “kayak”.")).toBeInTheDocument();
    // A failure would be announced as an alert; "no matches" is not one (note 14).
    expect(screen.queryByText(/temporarily unavailable/)).not.toBeInTheDocument();
    // "Search all content" still offers the richer surface.
    expect(screen.getByRole("option")).toHaveTextContent("Search all content for “kayak”");
  });

  it("explains a temporary failure with a retry, and an offline one differently", async () => {
    const user = userEvent.setup({ delay: null });
    let attempt = 0;
    const api = stubSearchApi({
      recentTasks: () => Promise.resolve([]),
      titles: () => {
        attempt += 1;
        return Promise.reject(
          attempt === 1
            ? new ApiError({
                status: 503,
                code: "search.unavailable",
                message: "",
                requestId: "r1",
              })
            : new ApiNetworkError(),
        );
      },
    });
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    renderSearch(<CommandPalette />, { api, actions });
    openPalette();
    await user.type(await screen.findByRole("combobox"), "port");
    // The message is shown and announced, so it appears twice: once visibly, once in the live region.
    expect(await screen.findAllByText("Search is temporarily unavailable")).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByText("You're offline")).not.toHaveLength(0);
    onLine.mockRestore();
  });

  it("keeps a locked or signed-out account from retrieving anything", async () => {
    const titles = vi.fn();
    const api = stubSearchApi({ titles, recentTasks: vi.fn() });
    const { unmount } = renderSearch(<CommandPalette />, {
      api,
      actions,
      session: lockedSession,
    });
    openPalette();
    expect(await screen.findAllByText("Search isn't available for this account")).not.toHaveLength(
      0,
    );
    act(() => searchOverlay.close());
    unmount();

    renderSearch(<CommandPalette />, { api, actions, session: signedOutSession });
    openPalette();
    expect(await screen.findAllByText("Your session ended")).not.toHaveLength(0);
    expect(titles).not.toHaveBeenCalled();
    expect(api.recentTasks).not.toHaveBeenCalled();
  });

  it("reports index freshness separately from the results", async () => {
    const user = userEvent.setup({ delay: null });
    const api = stubSearchApi({
      recentTasks: () => Promise.resolve([]),
      titles: () =>
        Promise.resolve(
          titleResponse([titleResult("Refresh my portfolio")], {
            status: "rebuilding",
            indexGeneration: 0,
            pendingIntents: 3,
          }),
        ),
    });
    renderSearch(<CommandPalette />, { api, actions });
    openPalette();
    await user.type(await screen.findByRole("combobox"), "port");
    expect(
      await screen.findByText("Search is rebuilding its index; task titles are still searched."),
    ).toBeInTheDocument();
  });
});

describe("the palette's actions mode", () => {
  it("switches with > and lists actions with their context and current shortcut", async () => {
    const user = userEvent.setup({ delay: null });
    const api = stubSearchApi({ recentTasks: () => Promise.resolve([]) });
    renderSearch(<CommandPalette />, { api, actions });
    openPalette();
    const input = await screen.findByRole("combobox", { name: "Search tasks" });
    await user.type(input, ">");
    await screen.findByRole("combobox", { name: "Search actions" });
    expect(screen.getByRole("listbox", { name: "Actions" })).toBeInTheDocument();
    expect(screen.getByText("Navigation")).toBeInTheDocument();
    const chat = screen.getByRole("option", { name: /Open Simon chat/ });
    expect(chat).toHaveTextContent("Open a task first");
    expect(chat).toHaveAttribute("aria-disabled", "true");
    expect(within(chat).getByText("G")).toBeInTheDocument();
    expect(within(chat).getByText("then")).toBeInTheDocument();

    // A disabled action never runs from the palette either (note 13).
    await user.keyboard("{Enter}");
    expect(focusChat.run).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toBeInTheDocument();

    // Backspace on an empty actions query goes back to task search.
    await user.keyboard("{Backspace}");
    await screen.findByRole("combobox", { name: "Search tasks" });
  });

  it("runs an enabled action through the registry after the overlay closes", async () => {
    const user = userEvent.setup({ delay: null });
    const api = stubSearchApi({ recentTasks: () => Promise.resolve([]) });
    renderSearch(<CommandPalette />, {
      api,
      actions,
      services: { route: { collection: "now", taskId: "0192f0a0-0000-7000-8000-000000000101" } },
    });
    openPalette();
    await user.type(await screen.findByRole("combobox"), ">chat");
    const chat = await screen.findByRole("option", { name: /Open Simon chat/ });
    expect(chat).not.toHaveAttribute("aria-disabled");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
    await waitFor(() => expect(focusChat.run).toHaveBeenCalledTimes(1));
    expect((focusChat.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      source: "palette",
    });
  });

  it("switches modes with the visible control and says when no action matches", async () => {
    const user = userEvent.setup({ delay: null });
    const api = stubSearchApi({ recentTasks: () => Promise.resolve([]) });
    renderSearch(<CommandPalette />, { api, actions });
    openPalette();
    await screen.findByRole("combobox", { name: "Search tasks" });
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const input = await screen.findByRole("combobox", { name: "Search actions" });
    expect(screen.getByRole("button", { name: "Actions" })).toHaveAttribute("aria-pressed", "true");
    await user.type(input, "unicorn");
    expect(await screen.findByText("No actions match “unicorn”.")).toBeInTheDocument();
  });

  it("hands the typed query to full search without putting it in the address", async () => {
    const user = userEvent.setup({ delay: null });
    const navigate = vi.fn();
    const api = stubSearchApi({
      recentTasks: () => Promise.resolve([]),
      titles: () => Promise.resolve(titleResponse([])),
    });
    renderSearch(<CommandPalette />, { api, actions, services: { navigate } });
    openPalette();
    await user.type(await screen.findByRole("combobox"), "quiet weekend");
    await user.click(await screen.findByRole("option", { name: /Search all content/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/search"));
    expect(recallSearchScreen()?.query).toBe("quiet weekend");
    expect(window.location.search).toBe("");
  });
});

describe("the palette and the session", () => {
  it("never searches while the query is only whitespace", async () => {
    const user = userEvent.setup({ delay: null });
    const titles = vi.fn();
    const api = stubSearchApi({ recentTasks: () => Promise.resolve([]), titles });
    renderSearch(<CommandPalette />, { api, actions, session: mayaSession });
    openPalette();
    await user.type(await screen.findByRole("combobox"), "   ");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(titles).not.toHaveBeenCalled();
  });
});
