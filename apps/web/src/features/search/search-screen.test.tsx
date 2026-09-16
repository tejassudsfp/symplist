import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { SearchContentRequest, TaskLocation } from "./api.ts";
import { defaultSearchFilters } from "./filters.ts";
import { SearchScreen } from "./search-screen.tsx";
import {
  consumeSearchJump,
  forgetSearchScreen,
  recallSearchScreen,
  rememberSearchScreen,
  searchFreshness,
} from "./store.ts";
import {
  lockedSession,
  messageHit,
  renderSearch,
  resultGroup,
  searchResponse,
  sectionHit,
  stubSearchApi,
  taskSummary,
} from "./test-support.tsx";

const navigation = vi.hoisted(() => ({ pathname: "/search", push: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: navigation.push,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

const portfolioTask = taskSummary("Refresh my portfolio");
const archivedTask = taskSummary("Choose portfolio photos");

const portfolioLocation: TaskLocation = {
  id: portfolioTask.id,
  title: portfolioTask.title,
  collection: "now",
  archived: false,
  parentTitle: null,
};

function groupWithSection() {
  return resultGroup("Refresh my portfolio", {
    task: { ...portfolioTask, titleHighlights: [{ start: 11, end: 20 }] },
    sections: [sectionHit()],
    sectionCount: 3,
    messages: [],
    messageCount: 0,
  });
}

beforeEach(() => {
  navigation.push.mockClear();
  forgetSearchScreen();
  searchFreshness.reset();
});

afterEach(() => {
  forgetSearchScreen();
  searchFreshness.reset();
});

describe("the full search screen", () => {
  it("focuses the query, states the scope and prompts before anything is typed", async () => {
    const content = vi.fn();
    renderSearch(<SearchScreen />, { api: stubSearchApi({ content }) });
    const input = screen.getByRole("searchbox", { name: "Search tasks, documents and chat" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(
      screen.getByText(/Task titles and documents in Now, Later and Unclassified/),
    ).toBeInTheDocument();
    expect(screen.getByText("Search your work")).toBeInTheDocument();
    expect(content).not.toHaveBeenCalled();
  });

  it("groups matches under their task with headings, snippets and counts", async () => {
    const user = userEvent.setup({ delay: null });
    const content = vi.fn(async () =>
      searchResponse([
        groupWithSection(),
        resultGroup("Send the project outline", {
          messages: [messageHit()],
          messageCount: 1,
          match: "chat",
        }),
      ]),
    );
    renderSearch(<SearchScreen />, { api: stubSearchApi({ content }) });
    await user.type(screen.getByRole("searchbox"), "portfolio");

    const groups = await screen.findAllByRole("article");
    expect(groups).toHaveLength(2);
    const first = groups[0] as HTMLElement;
    expect(within(first).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Refresh my portfolio",
    );
    expect(within(first).getByText("portfolio", { selector: "mark" })).toBeInTheDocument();
    expect(within(first).getByText("Projects to feature")).toBeInTheDocument();
    expect(within(first).getByText(/notes app/)).toBeInTheDocument();
    expect(
      within(first).getByRole("button", { name: "Show all 3 matches in this task" }),
    ).toBeInTheDocument();
    const second = groups[1] as HTMLElement;
    expect(within(second).getByText(/Simon ·/)).toBeInTheDocument();
    expect(content).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "portfolio", archive: "exclude" }),
      expect.anything(),
    );
  });

  it("opts into the archive, labels archived results and re-reads the task before opening", async () => {
    const user = userEvent.setup({ delay: null });
    const requests: SearchContentRequest[] = [];
    const content = vi.fn(async (request: SearchContentRequest) => {
      requests.push(request);
      const scope = {
        collections: ["now", "later", "unclassified"] as const,
        archive: request.archive,
        types: ["tasks", "documents"] as const,
        taskId: null,
        deadline: null,
      };
      return request.archive === "exclude"
        ? searchResponse([groupWithSection()], {
            scope: { ...scope, collections: [...scope.collections], types: [...scope.types] },
          })
        : searchResponse(
            [
              groupWithSection(),
              resultGroup("Choose portfolio photos", {
                task: { ...archivedTask, archived: true },
                sections: [],
                sectionCount: 0,
              }),
            ],
            { scope: { ...scope, collections: [...scope.collections], types: [...scope.types] } },
          );
    });
    const locateTask = vi.fn(
      async () => ({ ...portfolioLocation, collection: "later" }) as TaskLocation,
    );
    renderSearch(<SearchScreen />, { api: stubSearchApi({ content, locateTask }) });
    await user.type(screen.getByRole("searchbox"), "portfolio");
    await screen.findAllByRole("article");

    await user.click(screen.getByRole("radio", { name: "Active and archived" }));
    await waitFor(() => expect(requests.at(-1)?.archive).toBe("include"));
    const archived = await screen.findByText("Choose portfolio photos");
    expect(
      within(archived.closest("article") as HTMLElement).getByText("Archived"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Archived tasks are included/)).toBeInTheDocument();

    // Opening a section hit reads the task again, so a task moved since the search still opens right.
    await user.click(screen.getByText("Projects to feature"));
    await waitFor(() => expect(locateTask).toHaveBeenCalledWith(portfolioTask.id));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(
        `/later/${portfolioTask.id}?section=sec-projects-to-feature`,
      ),
    );
    const jump = consumeSearchJump(portfolioTask.id);
    expect(jump?.section).toMatchObject({ sectionId: "sec-projects-to-feature", ordinal: 2 });
    expect(recallSearchScreen()?.query).toBe("portfolio");
  });

  it("drops a result whose task is gone instead of opening the wrong thing", async () => {
    const user = userEvent.setup({ delay: null });
    const content = vi.fn(async () => searchResponse([groupWithSection()]));
    const locateTask = vi.fn(async () => null);
    renderSearch(<SearchScreen />, { api: stubSearchApi({ content, locateTask }) });
    await user.type(screen.getByRole("searchbox"), "portfolio");
    await user.click(await screen.findByRole("link", { name: /Refresh my portfolio/ }));
    expect(await screen.findByText(/that task is no longer available/)).toBeInTheDocument();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("says when a hit is stale and still opens the current version", async () => {
    const user = userEvent.setup({ delay: null });
    const content = vi.fn(async () =>
      searchResponse([
        resultGroup("Refresh my portfolio", {
          sections: [sectionHit({ stale: true, currentRevision: "rev-19" })],
          sectionCount: 1,
        }),
      ]),
    );
    renderSearch(<SearchScreen />, { api: stubSearchApi({ content }) });
    await user.type(screen.getByRole("searchbox"), "portfolio");
    expect(
      await screen.findByText("Changed since it was indexed; opens at the current version"),
    ).toBeInTheDocument();
  });

  it("separates no matches from a failure and offers a retry", async () => {
    const user = userEvent.setup({ delay: null });
    let attempt = 0;
    const content = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return searchResponse([]);
      throw new ApiError({
        status: 503,
        code: "search.unavailable",
        message: "",
        requestId: "r1",
      });
    });
    renderSearch(<SearchScreen />, { api: stubSearchApi({ content }) });
    await user.type(screen.getByRole("searchbox"), "kayak");
    // The visible empty state and the polite live region both say it, as the failure states do.
    expect(await screen.findAllByText("No results for “kayak”")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Include archived" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search chat too" })).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), " trip");
    expect(await screen.findAllByText("Search is temporarily unavailable")).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("refuses a malformed date range and explains an unavailable deadline filter", async () => {
    const user = userEvent.setup({ delay: null });
    const content = vi.fn(async (request: SearchContentRequest) => {
      if (request.deadline) {
        throw new ApiError({
          status: 422,
          code: "search.filter_unavailable",
          message: "",
          requestId: "r2",
        });
      }
      return searchResponse([groupWithSection()]);
    });
    renderSearch(<SearchScreen />, { api: stubSearchApi({ content }) });
    await user.type(screen.getByRole("searchbox"), "portfolio");
    await screen.findAllByRole("article");

    await user.selectOptions(screen.getByLabelText("Deadline filter"), "range");
    expect(await screen.findByText("Choose both dates for the range")).toBeInTheDocument();
    const calls = content.mock.calls.length;
    await user.type(screen.getByLabelText("From"), "2026-03-05");
    await user.type(screen.getByLabelText("To"), "2026-03-01");
    expect(await screen.findByText("The range ends before it starts")).toBeInTheDocument();
    expect(content.mock.calls).toHaveLength(calls);

    await user.selectOptions(screen.getByLabelText("Deadline filter"), "due_today");
    expect(await screen.findAllByText("Deadline filters aren't available yet")).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Clear deadline filter" }));
    await waitFor(() =>
      expect(screen.queryAllByText("Deadline filters aren't available yet")).toHaveLength(0),
    );
  });

  it("explains index freshness and offers a refresh when a newer generation arrives", async () => {
    const user = userEvent.setup({ delay: null });
    let generation = 7;
    const content = vi.fn(async () =>
      searchResponse([groupWithSection()], {
        status: "partial",
        indexGeneration: generation,
        pendingIntents: 2,
        notices: ["changes_pending", "chat_opt_in_required"],
      }),
    );
    renderSearch(<SearchScreen />, { api: stubSearchApi({ content, freshness: vi.fn() }) });
    await user.type(screen.getByRole("searchbox"), "portfolio");
    await screen.findAllByRole("article");
    expect(screen.getByText("Some changes aren't searchable yet.")).toBeInTheDocument();
    expect(screen.getByText(/Chat messages aren't searchable/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Settings" })).toHaveAttribute(
      "href",
      "/settings/account",
    );

    generation = 8;
    act(() => {
      searchFreshness.publish({ generation: 8, pending: 0 });
    });
    const refresh = await screen.findByRole("button", { name: "Refresh" });
    const before = content.mock.calls.length;
    await user.click(refresh);
    await waitFor(() => expect(content.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull());
  });

  it("pages with the server cursor and restarts when a cursor goes stale", async () => {
    const user = userEvent.setup({ delay: null });
    const content = vi.fn(async (request: SearchContentRequest) => {
      if (request.cursor === "c2") {
        throw new ApiError({
          status: 409,
          code: "search.cursor_stale",
          message: "",
          requestId: "r3",
          details: { indexGeneration: 9 },
        });
      }
      return searchResponse([groupWithSection()], { nextCursor: "c2" });
    });
    renderSearch(<SearchScreen />, { api: stubSearchApi({ content }) });
    await user.type(screen.getByRole("searchbox"), "portfolio");
    const more = await screen.findByRole("button", { name: "Show more results" });
    await user.click(more);
    expect(
      await screen.findByText("These results changed. Search again for a fresh list."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Search again" }));
    await waitFor(() => expect(screen.queryByText(/These results changed/)).toBeNull());
  });

  it("expands one task to every match and collapses again", async () => {
    const user = userEvent.setup({ delay: null });
    const content = vi.fn(async (request: SearchContentRequest) =>
      request.taskId
        ? searchResponse([
            resultGroup("Refresh my portfolio", {
              sections: [
                sectionHit(),
                sectionHit({ sectionId: "sec-next-steps", heading: "Next steps" }),
                sectionHit({ sectionId: "sec-links", heading: "Links" }),
              ],
              sectionCount: 3,
            }),
          ])
        : searchResponse([groupWithSection()]),
    );
    renderSearch(<SearchScreen />, { api: stubSearchApi({ content }) });
    await user.type(screen.getByRole("searchbox"), "portfolio");
    await user.click(await screen.findByRole("button", { name: /Show all 3 matches/ }));
    expect(await screen.findByText("Next steps")).toBeInTheDocument();
    expect(content).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: portfolioTask.id }));
    await user.click(screen.getByRole("button", { name: "Show fewer matches" }));
    await waitFor(() => expect(screen.queryByText("Next steps")).toBeNull());
  });

  it("moves through results with the arrow keys and clears with Escape", async () => {
    const user = userEvent.setup({ delay: null });
    const content = vi.fn(async () => searchResponse([groupWithSection()]));
    renderSearch(<SearchScreen />, { api: stubSearchApi({ content }) });
    const input = screen.getByRole("searchbox");
    await user.type(input, "portfolio");
    await screen.findAllByRole("article");
    const links = screen.getAllByRole("link");

    await user.keyboard("{ArrowDown}");
    expect(links[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(links[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(input).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
  });

  it("restores the query and filters when the reader comes back from a task", async () => {
    rememberSearchScreen({
      query: "portfolio",
      filters: { ...defaultSearchFilters, archive: "only" },
      returnHref: "/now",
      activeKey: null,
    });
    const content = vi.fn(async () => searchResponse([groupWithSection()]));
    renderSearch(<SearchScreen />, { api: stubSearchApi({ content }) });
    expect(screen.getByRole("searchbox")).toHaveValue("portfolio");
    expect(screen.getByRole("radio", { name: "Archived only" })).toBeChecked();
    await waitFor(() =>
      expect(content).toHaveBeenCalledWith(
        expect.objectContaining({ q: "portfolio", archive: "only" }),
        expect.anything(),
      ),
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("never searches for an account without access", async () => {
    const content = vi.fn();
    renderSearch(<SearchScreen />, {
      api: stubSearchApi({ content }),
      session: lockedSession,
    });
    expect(screen.getAllByText("Search isn't available for this account")).not.toHaveLength(0);
    expect(content).not.toHaveBeenCalled();
  });
});
