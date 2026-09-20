import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { SearchContentRequest } from "./api.ts";
import { InboxFind } from "./inbox-find.tsx";
import { forgetSearchScreen, recallSearchScreen } from "./store.ts";
import { surfaceFindTarget } from "./surface-find.ts";
import {
  renderSearch,
  resultGroup,
  searchResponse,
  stubSearchApi,
  taskSummary,
} from "./test-support.tsx";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/now",
  useRouter: () => ({
    push: navigation.push,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

const taskList = (
  <ul aria-label="Now tasks">
    <li>Refresh my portfolio</li>
  </ul>
);

beforeEach(() => {
  navigation.push.mockClear();
  forgetSearchScreen();
});

describe("find in the task list", () => {
  it("filters only its own collection and opens a match", async () => {
    const user = userEvent.setup({ delay: null });
    const requests: SearchContentRequest[] = [];
    const content = vi.fn(async (request: SearchContentRequest) => {
      requests.push(request);
      return searchResponse([
        resultGroup("Pick five projects to feature", {
          task: {
            ...taskSummary("Pick five projects to feature"),
            titleHighlights: [{ start: 5, end: 9 }],
          },
        }),
      ]);
    });
    renderSearch(<InboxFind collection="now">{taskList}</InboxFind>, {
      api: stubSearchApi({ content }),
    });
    expect(screen.getByRole("list", { name: "Now tasks" })).toBeInTheDocument();

    const field = screen.getByRole("searchbox", { name: "Find in Now" });
    await user.type(field, "five");
    const match = await screen.findByRole("link", { name: /Pick five projects to feature/ });
    expect(within(match).getByText("five", { selector: "mark" })).toBeInTheDocument();
    expect(requests.at(-1)).toMatchObject({
      q: "five",
      collections: ["now"],
      types: ["tasks"],
      archive: "exclude",
    });
    // The collection's own list is replaced while filtering, and comes back when the field clears.
    expect(screen.queryByRole("list", { name: "Now tasks" })).not.toBeInTheDocument();

    await user.click(match);
    expect(navigation.push).toHaveBeenCalledWith(
      `/now/${taskSummary("Pick five projects to feature").id}`,
    );

    await user.clear(field);
    expect(await screen.findByRole("list", { name: "Now tasks" })).toBeInTheDocument();
  });

  it("hands the query to full search, which touch users reach without a keyboard", async () => {
    const user = userEvent.setup({ delay: null });
    const content = vi.fn(async () => searchResponse([resultGroup("Refresh my portfolio")]));
    renderSearch(<InboxFind collection="now">{taskList}</InboxFind>, {
      api: stubSearchApi({ content }),
    });
    await user.type(screen.getByRole("searchbox", { name: "Find in Now" }), "portfolio");
    await user.click(await screen.findByRole("button", { name: /Search all content/ }));
    expect(navigation.push).toHaveBeenCalledWith("/search");
    expect(recallSearchScreen()?.query).toBe("portfolio");
  });

  it("says when nothing in the collection matches, and Escape clears only this field", async () => {
    const user = userEvent.setup({ delay: null });
    const content = vi.fn(async () => searchResponse([]));
    renderSearch(<InboxFind collection="later">{taskList}</InboxFind>, {
      api: stubSearchApi({ content }),
    });
    const field = screen.getByRole("searchbox", { name: "Find in Later" });
    await user.type(field, "kayak");
    expect(await screen.findByText("No tasks in Later match “kayak”.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(field).toHaveValue("");
    expect(await screen.findByRole("list", { name: "Now tasks" })).toBeInTheDocument();
  });

  it("explains a failure with a retry instead of showing an empty list", async () => {
    const user = userEvent.setup({ delay: null });
    let attempt = 0;
    const content = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new ApiError({
          status: 503,
          code: "search.unavailable",
          message: "",
          requestId: "r1",
        });
      }
      return searchResponse([resultGroup("Refresh my portfolio")]);
    });
    renderSearch(<InboxFind collection="now">{taskList}</InboxFind>, {
      api: stubSearchApi({ content }),
    });
    await user.type(screen.getByRole("searchbox", { name: "Find in Now" }), "port");
    expect(await screen.findAllByText("Search is temporarily unavailable")).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: /Refresh my portfolio/ })).toBeInTheDocument();
  });

  it("is the field `/` focuses while the task list has focus", async () => {
    renderSearch(
      <div data-pane="inbox">
        <InboxFind collection="now">{taskList}</InboxFind>
      </div>,
      { api: stubSearchApi({}) },
    );
    const field = screen.getByRole("searchbox", { name: "Find in Now" });
    field.checkVisibility = () => true;
    await waitFor(() => expect(surfaceFindTarget("inbox")).toBe(field));
  });
});
