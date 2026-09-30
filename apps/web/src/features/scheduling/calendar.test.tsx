import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Calendar } from "./calendar.tsx";
import { describeDay, longDay, rangeTitle } from "./calendar-model.ts";
import { schedulingTaskId, stubSchedulingApi } from "./test-support.ts";

/*
 * The deadline calendar (§12, task_schedule.md). The grid is a real table with real column headers and
 * one roving tab stop, a cell keeps itself short and hands the rest to the day panel, and every label a
 * person or a screen reader reads is a date they recognise rather than the ISO string behind it.
 *
 * "Today" is fixed to the day the tests navigate to, because the grid marks it and the day headings
 * name it; the stubbed preferences put the viewer in UTC, so grouping never depends on the machine.
 * Dates are written the way the viewer's locale writes them, so the names expected here come from the
 * same label helpers the component uses — `calendar-model.test.ts` is where the wording itself is held
 * to account, and these tests stay true on a machine that is not en-US.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-17T09:00:00Z"));
  window.history.replaceState(null, "", "/calendar?date=2026-09-17&view=month");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});
afterEach(() => vi.useRealTimers());

const item = {
  taskId: schedulingTaskId,
  title: "Prepare outline",
  collection: "now" as const,
  archived: false,
  deadline: { kind: "date" as const, date: "2026-09-17", zone: "Asia/Kathmandu" },
  deadlineAt: Date.parse("2026-09-17T18:15Z"),
  version: 1,
};
const timed = (taskId: string, title: string, local: string) => ({
  ...item,
  taskId,
  title,
  deadline: { kind: "timed" as const, local, zone: "UTC", disambiguation: "reject" as const },
  deadlineAt: Date.parse(`${local}Z`),
});

async function monthGrid() {
  return within(await screen.findByRole("table", { name: /Deadlines in September 2026/ }));
}

/** The exact accessible name of a day's button: the spelled-out date plus what is due on it. */
const dayName = (date: string, count: number) => describeDay(date, count);
/** Any day's button, whatever is due on it. */
const anyDay = (date: string) => new RegExp(`^${longDay(date)},`);

describe("deadline calendar", () => {
  it("draws the month as a table of the weeks it touches, with today marked", async () => {
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    // September 2026 spans five weeks; the old grid always drew six, ending in a dead row.
    expect(grid.getAllByRole("cell")).toHaveLength(35);
    expect(grid.getByRole("columnheader", { name: "Monday" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "September 2026" })).toBeInTheDocument();
    const day = grid.getByRole("button", { name: dayName("2026-09-17", 1) });
    expect(day).toHaveAttribute("tabindex", "0");
    expect(day).toHaveAttribute("aria-current", "date");
    expect(grid.getByRole("button", { name: dayName("2026-09-18", 0) })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(grid.getByRole("link", { name: /Prepare outline/ })).toHaveAttribute(
      "href",
      `/tasks/${item.taskId}`,
    );
    expect(api.save).not.toHaveBeenCalled();
  });

  it("fills the cells the month spills into, instead of drawing them permanently empty", async () => {
    // The September grid completes the weeks September touches, so it has cells for 31 August and the
    // first four days of October. The read used to be the month alone, so those cells showed nothing
    // however much was due on them, and their accessible name said "no deadlines" — a person stepping
    // from the end of September into October saw an empty week that was not empty.
    const spilled = timed(
      "019947aa-0000-7000-8000-000000000021",
      "Return the proofs",
      "2026-08-31T09:00",
    );
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item, spilled], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    expect(api.calendar).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: "2026-08-31", to: "2026-10-04" }),
    );
    expect(grid.getByRole("link", { name: /Return the proofs/ })).toBeInTheDocument();
    expect(grid.getByRole("button", { name: dayName("2026-08-31", 1) })).toBeInTheDocument();
  });

  it("moves through days with the arrows and Home, and pulls a new range in at the edges", async () => {
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    const day = grid.getByRole("button", { name: anyDay("2026-09-17") });
    day.focus();
    fireEvent.keyDown(day, { key: "ArrowRight" });
    const next = grid.getByRole("button", { name: anyDay("2026-09-18") });
    expect(next).toHaveFocus();
    fireEvent.keyDown(next, { key: "Home" });
    expect(grid.getByRole("button", { name: anyDay("2026-09-14") })).toHaveFocus();
    fireEvent.keyDown(grid.getByRole("button", { name: anyDay("2026-09-14") }), { key: "End" });
    expect(grid.getByRole("button", { name: anyDay("2026-09-20") })).toHaveFocus();

    // The first cell of the grid belongs to August; stepping off it moves the range and keeps focus.
    const spill = grid.getByRole("button", { name: anyDay("2026-08-31") });
    spill.focus();
    fireEvent.keyDown(spill, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(api.calendar).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: "2026-07-27", to: "2026-09-06" }),
      ),
    );
    const august = within(await screen.findByRole("table", { name: /Deadlines in August 2026/ }));
    await waitFor(() =>
      expect(august.getByRole("button", { name: anyDay("2026-08-30") })).toHaveFocus(),
    );
  });

  it("pages by month with PageDown and keeps the day of the month", async () => {
    const api = stubSchedulingApi();
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    const day = grid.getByRole("button", { name: anyDay("2026-09-17") });
    day.focus();
    fireEvent.keyDown(day, { key: "PageDown" });
    await waitFor(() =>
      expect(api.calendar).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: "2026-09-28", to: "2026-11-01" }),
      ),
    );
    const october = within(await screen.findByRole("table", { name: /Deadlines in October 2026/ }));
    await waitFor(() =>
      expect(october.getByRole("button", { name: anyDay("2026-10-17") })).toHaveFocus(),
    );
  });

  it("keeps a busy day short and opens the rest in the day panel", async () => {
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({
        items: [
          item,
          timed("019947aa-0000-7000-8000-000000000002", "Call the printer", "2026-09-17T11:00"),
          timed("019947aa-0000-7000-8000-000000000003", "Read the draft", "2026-09-17T15:30"),
        ],
        nextCursor: null,
      })),
    });
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    // Two entries fit a month cell; the third is counted, not crammed in.
    expect(grid.getByRole("link", { name: /Prepare outline/ })).toBeInTheDocument();
    expect(grid.getByRole("link", { name: /Call the printer/ })).toBeInTheDocument();
    expect(grid.queryByRole("link", { name: /Read the draft/ })).not.toBeInTheDocument();
    await userEvent.click(
      grid.getByRole("button", { name: `Show all 3 deadlines on ${longDay("2026-09-17")}` }),
    );
    const panel = within(
      screen.getByRole("region", { name: `Deadlines on ${longDay("2026-09-17")}` }),
    );
    expect(panel.getAllByRole("listitem")).toHaveLength(3);
    expect(panel.getByRole("link", { name: "Read the draft" })).toBeInTheDocument();
    expect(panel.getByText("All day", { exact: false })).toBeInTheDocument();
  });

  it("opens and closes a day, and says plainly when nothing is due on it", async () => {
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    const empty = grid.getByRole("button", { name: dayName("2026-09-18", 0) });
    await userEvent.click(empty);
    expect(empty).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("region", { name: `Deadlines on ${longDay("2026-09-18")}` }),
    ).toHaveTextContent("No deadlines on this date.");
    await userEvent.click(empty);
    expect(empty).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("region", { name: `Deadlines on ${longDay("2026-09-18")}` }),
    ).not.toBeInTheDocument();
  });

  it("opens the existing schedule editor from a named Change date, without mutating on open", async () => {
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    await userEvent.click(grid.getByRole("button", { name: dayName("2026-09-17", 1) }));
    await userEvent.click(screen.getByRole("button", { name: "Change date for Prepare outline" }));
    expect(
      await screen.findByRole("dialog", { name: "Deadline and reminders" }),
    ).toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();
  });

  it("offers the dropped day to the editor instead of rescheduling behind the person's back", async () => {
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    const target = grid.getByRole("button", { name: anyDay("2026-09-24") }).closest("td");
    expect(target).not.toBeNull();
    fireEvent.drop(target as HTMLElement, {
      dataTransfer: { getData: () => item.taskId },
    });
    const dialog = await screen.findByRole("dialog", { name: "Deadline and reminders" });
    await waitFor(() =>
      expect(within(dialog).getByLabelText("Deadline date")).toHaveValue("2026-09-24"),
    );
    expect(api.save).not.toHaveBeenCalled();
  });

  it("moves ranges and collections through bounded read queries and offers an empty state", async () => {
    const api = stubSchedulingApi();
    render(<Calendar api={api} />);
    await screen.findByText("No deadlines in this range. Dates are optional.");
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() =>
      expect(api.calendar).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: "2026-09-28", to: "2026-11-01" }),
      ),
    );
    await userEvent.selectOptions(screen.getByLabelText("Collection"), "later");
    await waitFor(() =>
      expect(api.calendar).toHaveBeenLastCalledWith(
        expect.objectContaining({ collection: "later" }),
      ),
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Include completed" }));
    await waitFor(() =>
      expect(api.calendar).toHaveBeenLastCalledWith(expect.objectContaining({ archived: "true" })),
    );
    await userEvent.click(screen.getByRole("button", { name: "Without a date" }));
    await screen.findByText("Every task has a deadline");
    await waitFor(() =>
      expect(api.calendar).toHaveBeenLastCalledWith(
        expect.objectContaining({ unscheduled: "true" }),
      ),
    );
    expect(window.location.search).toContain("date=2026-10-01");
  });

  it("reads a week as seven days and an agenda as dated groups", async () => {
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    await monthGrid();
    await userEvent.click(screen.getByRole("button", { name: "Week" }));
    await waitFor(() =>
      expect(api.calendar).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: "2026-09-14", to: "2026-09-20" }),
      ),
    );
    const week = within(
      await screen.findByRole("table", {
        name: `Deadlines in ${rangeTitle("week", "2026-09-14", "2026-09-20")}`,
      }),
    );
    expect(week.getAllByRole("cell")).toHaveLength(7);
    expect(screen.getByRole("button", { name: "Previous week" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Agenda" }));
    expect(
      await screen.findByRole("heading", {
        level: 3,
        name: `Today · ${longDay("2026-09-17")}`,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Prepare outline" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("handles invalid URL dates and failed reads without crashing or inventing events", async () => {
    window.history.replaceState(null, "", "/calendar?date=2026-99-99");
    const api = stubSchedulingApi({ calendar: vi.fn().mockRejectedValue({ code: "offline" }) });
    render(<Calendar api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Check your connection/);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.calendar).toHaveBeenCalledTimes(2));
  });

  it("keeps the pages already read when another page of the same range is asked for", async () => {
    const second = timed("019947aa-0000-7000-8000-000000000009", "Second page", "2026-09-19T10:00");
    const calendar = vi
      .fn()
      .mockResolvedValueOnce({ items: [item], nextCursor: schedulingTaskId })
      .mockResolvedValue({ items: [second], nextCursor: null });
    const api = stubSchedulingApi({ calendar });
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    expect(grid.getByRole("link", { name: /Prepare outline/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More tasks" }));
    const filled = await monthGrid();
    expect(filled.getByRole("link", { name: /Prepare outline/ })).toBeInTheDocument();
    expect(filled.getByRole("link", { name: /Second page/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More tasks" })).not.toBeInTheDocument();
  });
});

/*
 * The four defects a person actually hit in the month grid. Every one of them is about the grid being
 * taller than the viewport or wider than its contents, which is why none of them showed up in the tests
 * above: they are all true of the DOM and wrong on a screen.
 */
describe("reading a day on a real screen", () => {
  it("brings the day panel into view and moves focus into it", async () => {
    // A month is five or six rows tall, so the panel renders below the fold on a laptop and always off
    // screen on a phone — where the cells are dots and the panel is the only way to read a day. Clicking
    // a day looked like nothing happening.
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const api = stubSchedulingApi({
        calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
      });
      render(<Calendar api={api} />);
      const grid = await monthGrid();
      await userEvent.click(grid.getByRole("button", { name: dayName("2026-09-17", 1) }));
      const region = screen.getByRole("region", { name: `Deadlines on ${longDay("2026-09-17")}` });
      expect(scrollIntoView).toHaveBeenCalled();
      expect(document.activeElement).toBe(region);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("hands focus back to the day when the panel is closed", async () => {
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    const day = grid.getByRole("button", { name: dayName("2026-09-17", 1) });
    await userEvent.click(day);
    await userEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(document.activeElement).toBe(day);
  });

  it("closes the panel with Escape from inside it and returns focus to the day", async () => {
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    const day = grid.getByRole("button", { name: dayName("2026-09-17", 1) });
    await userEvent.click(day);
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("region", { name: `Deadlines on ${longDay("2026-09-17")}` }),
    ).not.toBeInTheDocument();
    expect(document.activeElement).toBe(day);
  });

  it("counts the deadlines the phone-width dots cannot show", async () => {
    // Four dots and then silence made a day with four deadlines and a day with forty look identical.
    const many = Array.from({ length: 6 }, (_, index) =>
      timed(
        `019947aa-0000-7000-8000-00000000001${index}`,
        `Deadline ${index}`,
        `2026-09-17T1${index}:00`,
      ),
    );
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: many, nextCursor: null })),
    });
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    const day = grid.getByRole("button", { name: dayName("2026-09-17", 6) });
    expect(day).toHaveTextContent("+3");
    // The count a screen reader hears is the real one, not the dots; the strip stays decorative.
    expect(day).toHaveAccessibleName(describeDay("2026-09-17", 6));
  });

  it("keeps the drop highlight on while the pointer crosses a cell's own entries", async () => {
    // `dragenter` and `dragleave` bubble, so moving from a cell onto one of its entries fired a leave for
    // the cell and the highlight flickered off and on under the pointer.
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    const grid = await monthGrid();
    const entry = grid.getByRole("link", { name: /Prepare outline/ });
    const cell = entry.closest("td");
    expect(cell).not.toBeNull();
    // A constructed MouseEvent rather than `fireEvent.dragLeave`: jsdom has no DragEvent, so
    // `fireEvent`'s init drops `relatedTarget`, and `relatedTarget` is the whole point of the guard.
    const leave = (relatedTarget: Node) =>
      fireEvent(
        cell as HTMLElement,
        new MouseEvent("dragleave", { bubbles: true, cancelable: true, relatedTarget }),
      );
    fireEvent.dragEnter(cell as HTMLElement);
    expect(cell).toHaveClass("bg-sym-hover");
    leave(entry);
    expect(cell).toHaveClass("bg-sym-hover");
    leave(document.body);
    expect(cell).not.toHaveClass("bg-sym-hover");
  });

  it("keeps the range title on one line so the toolbar wraps instead of the date", async () => {
    const api = stubSchedulingApi();
    render(<Calendar api={api} />);
    const title = await screen.findByRole("heading", {
      level: 2,
      name: rangeTitle("month", "2026-09-01", "2026-09-30"),
    });
    expect(title).toHaveClass("whitespace-nowrap");
  });

  it("reads a week as a dated list at phone width, where a column cannot hold a title", async () => {
    // Seven columns across a phone leaves each one about forty pixels wide, so a week grid shows dots
    // and nothing else — strictly less than the month grid it replaces, on the same screen.
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    await monthGrid();
    await userEvent.click(screen.getByRole("button", { name: "Week" }));
    await waitFor(() =>
      expect(api.calendar).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: "2026-09-14", to: "2026-09-20" }),
      ),
    );
    // It is still a week: its own range, its own step, and its deadlines under a day heading.
    expect(screen.getByRole("button", { name: "Previous week" })).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 3, name: `Today · ${longDay("2026-09-17")}` }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Prepare outline" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("lets a week cell's title take a second line instead of cutting it off", async () => {
    const api = stubSchedulingApi({
      calendar: vi.fn(async () => ({ items: [item], nextCursor: null })),
    });
    render(<Calendar api={api} />);
    const month = await monthGrid();
    // A month cell has four or five rows above and below it, so it keeps every entry on one line.
    expect(month.getByText("Prepare outline")).toHaveClass("truncate");
    await userEvent.click(screen.getByRole("button", { name: "Week" }));
    const week = within(
      await screen.findByRole("table", {
        name: `Deadlines in ${rangeTitle("week", "2026-09-14", "2026-09-20")}`,
      }),
    );
    expect(week.getByText("Prepare outline")).toHaveClass("line-clamp-2");
  });
});
