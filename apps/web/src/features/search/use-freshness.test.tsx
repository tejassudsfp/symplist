import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchApi } from "./api.ts";
import { searchFreshness } from "./store.ts";
import { stubSearchApi } from "./test-support.tsx";
import { FRESHNESS_POLL_MS, useFreshnessWatch } from "./use-freshness.ts";

function Watcher({
  api,
  shownGeneration = 7,
  pending = 2,
  status = "partial" as const,
  active = true,
  rebuildExpected = false,
}: {
  readonly api: SearchApi;
  readonly shownGeneration?: number;
  readonly pending?: number;
  readonly status?: "ready" | "partial" | "rebuilding";
  readonly active?: boolean;
  readonly rebuildExpected?: boolean;
}) {
  const watch = useFreshnessWatch(api, {
    active,
    shownGeneration,
    pending,
    status,
    rebuildExpected,
  });
  return (
    <button type="button" onClick={watch.acknowledge}>
      {watch.newerAvailable ? "newer" : "current"}
    </button>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  searchFreshness.reset();
});

afterEach(() => {
  vi.useRealTimers();
  searchFreshness.reset();
});

describe("watching index freshness", () => {
  it("polls only while the shown results are behind the index", async () => {
    const freshness = vi.fn(async () => ({
      status: "partial" as const,
      indexGeneration: 8,
      pendingIntents: 0,
    }));
    const api = stubSearchApi({ freshness });
    const { rerender } = render(<Watcher api={api} />);
    expect(freshness).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS);
    });
    expect(freshness).toHaveBeenCalledTimes(1);
    // A generation newer than the one on screen offers a refresh instead of replacing results.
    expect(screen.getByRole("button")).toHaveTextContent("newer");

    rerender(<Watcher api={api} status="ready" pending={0} shownGeneration={8} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS * 3);
    });
    expect(freshness).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button")).toHaveTextContent("current");
  });

  it("never polls for a partial result no publication can change", async () => {
    // `partial` also means the account is past the index size limit or the query had more matches
    // than one ranking pass keeps. Nothing the writer publishes clears either, so a poll on the
    // status alone would run for as long as the screen is open and never learn anything.
    const freshness = vi.fn();
    render(<Watcher api={stubSearchApi({ freshness })} status="partial" pending={0} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS * 4);
    });
    expect(freshness).not.toHaveBeenCalled();
  });

  it("polls a partial result while the chat rebuild it is waiting for is still coming", async () => {
    const freshness = vi.fn(async () => ({
      status: "ready" as const,
      indexGeneration: 9,
      pendingIntents: 0,
    }));
    render(
      <Watcher
        api={stubSearchApi({ freshness })}
        status="partial"
        pending={0}
        rebuildExpected
        shownGeneration={8}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS);
    });
    expect(freshness).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button")).toHaveTextContent("newer");
  });

  it("polls while the index is rebuilding, even with nothing pending", async () => {
    const freshness = vi.fn(async () => ({
      status: "ready" as const,
      indexGeneration: 3,
      pendingIntents: 0,
    }));
    render(<Watcher api={stubSearchApi({ freshness })} status="rebuilding" pending={0} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS);
    });
    expect(freshness).toHaveBeenCalledTimes(1);
  });

  it("takes a search.freshness event from the app's socket without polling", async () => {
    const freshness = vi.fn();
    render(<Watcher api={stubSearchApi({ freshness })} status="ready" pending={0} />);
    expect(screen.getByRole("button")).toHaveTextContent("current");
    act(() => {
      searchFreshness.publish({ generation: 9, pending: 0 });
    });
    expect(screen.getByRole("button")).toHaveTextContent("newer");
    expect(freshness).not.toHaveBeenCalled();
  });

  it("hides the offer once it is acknowledged, until the next generation", async () => {
    render(<Watcher api={stubSearchApi({})} status="ready" pending={0} />);
    act(() => {
      searchFreshness.publish({ generation: 9, pending: 0 });
    });
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("newer");
    act(() => button.click());
    expect(button).toHaveTextContent("current");
    act(() => {
      searchFreshness.publish({ generation: 10, pending: 0 });
    });
    expect(button).toHaveTextContent("newer");
  });

  it("never polls for a viewer who is not looking at results", async () => {
    const freshness = vi.fn();
    render(<Watcher api={stubSearchApi({ freshness })} active={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS * 2);
    });
    expect(freshness).not.toHaveBeenCalled();
  });

  it("keeps the results on screen when a poll fails", async () => {
    const freshness = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<Watcher api={stubSearchApi({ freshness })} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS);
    });
    expect(freshness).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button")).toHaveTextContent("current");
  });
});
