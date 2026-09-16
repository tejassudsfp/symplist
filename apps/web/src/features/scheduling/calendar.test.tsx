import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Calendar } from "./calendar.tsx";
import { schedulingTaskId, stubSchedulingApi } from "./test-support.ts";

beforeEach(() => {
  window.history.replaceState(null, "", "/calendar?date=2026-09-17&view=month");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});
const item = {
  taskId: schedulingTaskId,
  title: "Prepare outline",
  collection: "now" as const,
  archived: false,
  deadline: { kind: "date" as const, date: "2026-09-17", zone: "Asia/Kathmandu" },
  deadlineAt: Date.parse("2026-09-17T18:15Z"),
  version: 1,
};
describe("deadline calendar", () => {
  it("renders all-day deadlines without provider accounts and the keyboard has a tab stop", async () => {
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    expect(await screen.findByRole("link", { name: item.title })).toHaveAttribute(
      "href",
      `/tasks/${item.taskId}`,
    );
    expect(screen.getByText("All day", { exact: false })).toBeInTheDocument();
    const grid = screen.getByRole("table", { name: "month deadlines" });
    const day = within(grid).getByRole("button", { name: "2026-09-17" });
    expect(day).toHaveAttribute("tabindex", "0");
    day.focus();
    fireEvent.keyDown(day, { key: "ArrowRight" });
    expect(within(grid).getByRole("button", { name: "2026-09-18" })).toHaveFocus();
    await userEvent.click(within(grid).getByRole("button", { name: "2026-09-18" }));
    expect(screen.getByRole("region", { name: "Selected date 2026-09-18" })).toHaveTextContent(
      "No deadlines on this date.",
    );
    expect(api.save).not.toHaveBeenCalled();
  });
  it("moves ranges and collections through bounded read queries and offers an empty state", async () => {
    const api = stubSchedulingApi();
    render(<Calendar api={api} />);
    await screen.findByText("No deadlines in this range. Dates are optional.");
    await userEvent.click(screen.getByRole("button", { name: "Next range" }));
    await waitFor(() =>
      expect(api.calendar).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: "2026-10-01", to: "2026-10-31" }),
      ),
    );
    await userEvent.selectOptions(screen.getByLabelText("Collection"), "later");
    await waitFor(() =>
      expect(api.calendar).toHaveBeenLastCalledWith(
        expect.objectContaining({ collection: "later" }),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Unscheduled tasks" }));
    await screen.findByText("Every task in this collection has a deadline.");
    expect(window.location.search).toContain("date=2026-10-01");
  });
  it("opens the existing schedule editor for an explicit date change without mutating on open", async () => {
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    await screen.findByRole("link", { name: item.title });
    await userEvent.click(screen.getByRole("button", { name: "Change date" }));
    expect(
      await screen.findByRole("dialog", { name: "Deadline and reminders" }),
    ).toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();
  });
  it("handles invalid URL dates and failed reads without crashing or inventing events", async () => {
    window.history.replaceState(null, "", "/calendar?date=2026-99-99");
    const api = stubSchedulingApi({ calendar: vi.fn().mockRejectedValue({ code: "offline" }) });
    render(<Calendar api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Check your connection/);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.calendar).toHaveBeenCalledTimes(2));
  });
});
