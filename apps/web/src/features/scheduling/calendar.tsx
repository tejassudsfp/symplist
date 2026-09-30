"use client";
import type { SchedulingCalendarItem } from "@symplist/contracts";
import { cn } from "cn";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { type DragEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, ThemeIllustration } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Spinner } from "@/components/ui/spinner";
import { createSchedulingApi, type SchedulingApi, schedulingMessage } from "./api.ts";
import {
  addMonths,
  type CalendarView,
  calendarViews,
  type DeadlineState,
  dayHeading,
  deadlineState,
  describeDay,
  gridDays,
  groupByDay,
  isCalendarDate,
  longDay,
  orderedDays,
  rangeOf,
  rangeTitle,
  readRange,
  stepName,
  timeLabel,
  unscheduledDay,
  weekdayNames,
  weeksOf,
} from "./calendar-model.ts";
import { ScheduleEditor } from "./schedule-editor.tsx";
import { deliveryLabel, localDate, shiftDate } from "./time-display.ts";

/** How many deadlines a cell lists before it collapses the rest behind "+N more". */
const cellEntryLimit = { month: 2, week: 6 } as const;

/**
 * How many dots the phone-width strip draws before it counts the rest instead.
 *
 * It used to draw four and then stop, which made a day with four deadlines and a day with forty look
 * exactly alike — on the width where the dots are the only thing a cell shows. Three and a number says
 * more in less space.
 */
const cellDotLimit = 3;

const viewLabel: Record<CalendarView, string> = { month: "Month", week: "Week", agenda: "Agenda" };

/** The dot in front of an entry: the one place the grid uses colour, and only from the theme tokens. */
const stateDot: Record<DeadlineState, string> = {
  completed: "bg-sym-faint",
  overdue: "bg-sym-danger",
  timed: "bg-sym-accent",
  all_day: "bg-sym-ink",
  none: "bg-sym-line-strong",
};

/** The word that names a state in text; a deadline that is simply due says nothing extra. */
const stateWord: Record<DeadlineState, string> = {
  completed: "Completed",
  overdue: "Overdue",
  timed: "",
  all_day: "",
  none: "",
};

/**
 * The deadline calendar (§12, task_schedule.md): a month, a week or an agenda of the deadlines tasks
 * already have, with no connected calendar anywhere. It is a read view with two writes — dragging a
 * task onto a day and "Change date" — and both go through the existing schedule editor, so the
 * deadline rules stay in one place.
 *
 * The grid is a real `<table>` with real `<th scope="col">` headers and no display overrides, because a
 * month is a table and keeping the native semantics is what makes a cell announce its column. One
 * roving tab stop plus arrows, Home/End and PageUp/PageDown walks it, and the range is refetched
 * underneath a grid that stays mounted, so keyboard focus is never dropped on the body.
 *
 * Cells stay deliberately quiet — a dot, a time and a title — because a month cell is a few dozen
 * pixels wide: a day's full entries, with their actions, open in the panel under the grid. At phone
 * width the cells shrink to dots and that panel is how a day is read.
 */
export function Calendar({ api: provided }: { api?: SchedulingApi }) {
  const api = useMemo(() => provided ?? createSchedulingApi(), [provided]);
  const [zone, setZone] = useState("UTC");
  const [ready, setReady] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [view, setView] = useState<CalendarView>("month");
  const [collection, setCollection] = useState<"all" | "now" | "later" | "unclassified">("all");
  const [archived, setArchived] = useState(false);
  const [unscheduled, setUnscheduled] = useState(false);
  const [items, setItems] = useState<readonly SchedulingCalendarItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<{ taskId: string; date?: string } | null>(null);
  const [focusedDate, setFocusedDate] = useState(date);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  // False until the browser has been asked, so the server and the first client render agree.
  const [narrow, setNarrow] = useState(false);
  const grid = useRef<HTMLTableElement>(null);
  const panel = useRef<HTMLElement>(null);
  const epoch = useRef(0);
  const restoreDayFocus = useRef(false);
  const panelId = useId();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setZone(browserZone);
    const fromUrl = params.get("date");
    const selected = isCalendarDate(fromUrl) ? fromUrl : localDate(Date.now(), browserZone);
    setDate(selected);
    setFocusedDate(selected);
    // Tailwind's `md`, which is the width the grid's cells stop being able to hold a title. It is
    // watched rather than read once, because a desktop window dragged narrow crosses it too.
    const phone = window.matchMedia("(max-width: 767px)");
    setNarrow(phone.matches);
    const onWidth = (event: MediaQueryListEvent) => setNarrow(event.matches);
    phone.addEventListener("change", onWidth);
    const desiredView = params.get("view");
    if (desiredView === "week" || desiredView === "agenda" || desiredView === "month")
      setView(desiredView);
    else if (phone.matches) setView("agenda");
    let active = true;
    void api
      .preferences()
      .then((preferences) => {
        if (active) setZone(preferences.data.zone);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
      phone.removeEventListener("change", onWidth);
    };
  }, [api]);

  // The range the view is titled by, and the — for a month, wider — range it has cells to fill.
  const { from: first, to: last } = rangeOf(view, date);
  const read = readRange(view, date);
  const query = {
    from: read.from,
    to: read.to,
    zone,
    collection,
    archived: archived ? ("true" as const) : ("false" as const),
    unscheduled: unscheduled ? ("true" as const) : ("false" as const),
  };
  const queryKey = JSON.stringify(query);
  const currentQuery = useRef(query);
  currentQuery.current = query;
  useEffect(() => {
    void queryKey;
    void revision;
    if (!ready) return;
    let active = true;
    epoch.current++;
    setBusy(true);
    setError("");
    void api
      .calendar(currentQuery.current)
      .then((result) => {
        if (active) {
          setItems(result.items);
          setCursor(result.nextCursor);
        }
      })
      .catch((failure) => {
        if (active) {
          setItems([]);
          setError(schedulingMessage(failure));
        }
      })
      .finally(() => {
        if (active) {
          setBusy(false);
          setLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, [api, queryKey, revision, ready]);

  const days = gridDays(view, date);
  const today = localDate(Date.now(), zone);
  const now = Date.now();
  const byDay = groupByDay(items, zone);
  const title = rangeTitle(view, first, last);
  const step = stepName(view);
  /**
   * A week is read as a dated list at phone width.
   *
   * A month grid on a phone is worth its space: the cells are dots, but thirty-odd of them draw the
   * shape of the month, and the day panel reads any one of them out. A *week* grid on a phone is the
   * same seven columns of forty-odd pixels with six sevenths of them empty — it costs the same screen
   * and carries strictly less than the month it replaced, because a column that narrow cannot hold a
   * title and there are only seven of them to make a shape out of. The list is the same one the agenda
   * draws, so a week keeps its own title and its own Previous/Next; only the shape changes.
   */
  const listMode = view === "agenda" || unscheduled || (narrow && view === "week");
  const limit = view === "week" ? cellEntryLimit.week : cellEntryLimit.month;
  // A failed range read leaves nothing to show; a failed extra page keeps the pages already read.
  const showData = loaded && (items.length > 0 || !error);

  // Focus follows the person across a range boundary: the day they walked to only exists once the grid
  // has re-rendered on the new range, so the move is finished here rather than in the key handler.
  // Crossing a boundary always changes the focused day, which is what brings this effect back around.
  useEffect(() => {
    if (!restoreDayFocus.current) return;
    const target = grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedDate}"]`);
    if (!target) return;
    restoreDayFocus.current = false;
    target.focus();
  }, [focusedDate]);

  /**
   * Opening a day used to look like nothing happening.
   *
   * The panel renders under the grid, and a month is five or six rows tall, so on a laptop it opened
   * below the fold and on a phone — where the cells are dots and the panel is the only way to read a day
   * at all — it was always off screen. Bringing it into view and moving focus into it is what makes the
   * disclosure a disclosure: the region is nowhere near the control that opened it, which is exactly when
   * focus should follow.
   */
  useEffect(() => {
    if (!selectedDay) return;
    const region = panel.current;
    if (!region) return;
    region.scrollIntoView?.({ block: "nearest" });
    region.focus?.();
  }, [selectedDay]);

  /** Closes the day panel and hands focus back to the day it belonged to. */
  const closeDay = (day: string | null) => {
    setSelectedDay(null);
    if (day) grid.current?.querySelector<HTMLButtonElement>(`[data-date="${day}"]`)?.focus();
  };

  const navigateDate = (next: string, nextView = view) => {
    setDate(next);
    setFocusedDate(next);
    // A day panel left open for a day outside the new range would describe something off screen.
    setSelectedDay((current) =>
      current && gridDays(nextView, next).includes(current) ? current : null,
    );
    window.history.replaceState(null, "", `/calendar?date=${next}&view=${nextView}`);
  };
  const shiftRange = (direction: number) => {
    navigateDate(view === "week" ? shiftDate(date, direction * 7) : addMonths(first, direction));
  };
  const moveFocus = (day: string, delta: number) => {
    const next = shiftDate(day, delta);
    if (days.includes(next)) {
      setFocusedDate(next);
      grid.current?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus();
      return;
    }
    restoreDayFocus.current = true;
    navigateDate(next);
  };
  /** PageUp/PageDown keep the day of the month, clamped to a shorter month the way a date picker does. */
  const movePage = (day: string, months: number) => {
    const target = addMonths(day, months);
    const end = shiftDate(addMonths(target, 1), -1);
    const wanted = `${target.slice(0, 7)}-${day.slice(8)}`;
    restoreDayFocus.current = true;
    navigateDate(wanted > end ? end : wanted);
  };

  const tabDay = days.includes(focusedDate) ? focusedDate : days.includes(date) ? date : days[0];

  const beginDrag = (item: SchedulingCalendarItem) => (event: DragEvent<HTMLElement>) => {
    event.dataTransfer.setData("application/x-symplist-task", item.taskId);
    event.dataTransfer.effectAllowed = "move";
  };

  /**
   * A compact cell entry: a dot, the time when it has one, and the title. The dot carries no meaning of
   * its own, so the name a screen reader hears is written out in full and leads with the task's title.
   */
  const cellEntry = (item: SchedulingCalendarItem) => {
    const state = deadlineState(item, now);
    // A week cell is a fifth of the height of the page with at most six entries in it, so a title that
    // does not fit the column takes a second line rather than being cut off. A month cell has four or
    // five rows above and below it and no height to give away, so there it stays on one line.
    const roomy = view === "week";
    const when =
      item.deadline?.kind === "date"
        ? "all day"
        : item.deadlineAt !== null
          ? timeLabel(item.deadlineAt, zone)
          : "no deadline";
    return (
      <Link
        key={item.taskId}
        href={`/tasks/${item.taskId}`}
        data-state={state}
        draggable={!item.archived}
        onDragStart={beginDrag(item)}
        aria-label={`${item.title}, ${when}${stateWord[state] ? `, ${stateWord[state]}` : ""}`}
        className={cn(
          "flex min-h-6 min-w-0 gap-1.5 rounded-sym px-1 text-[12px] text-sym-text hover:bg-sym-hover",
          roomy ? "items-baseline py-0.5" : "items-center",
        )}
      >
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", roomy && "self-center", stateDot[state])}
        />
        {state !== "all_day" && item.deadlineAt !== null ? (
          <span className="shrink-0 text-[11px] text-sym-muted tabular-nums">
            {timeLabel(item.deadlineAt, zone)}
          </span>
        ) : null}
        <span
          className={cn(
            roomy ? "line-clamp-2" : "truncate",
            item.archived && "text-sym-muted line-through",
          )}
        >
          {item.title}
        </span>
      </Link>
    );
  };

  /** A full entry for the agenda and the day panel: the title, when it is due, and its one action. */
  const listEntry = (item: SchedulingCalendarItem) => {
    const state = deadlineState(item, now);
    return (
      <li
        key={item.taskId}
        data-state={state}
        draggable={!item.archived}
        onDragStart={beginDrag(item)}
        className="flex items-center gap-2.5 rounded-sym border border-sym-line bg-sym-surface px-3 py-2"
      >
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", stateDot[state])} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Link
            href={`/tasks/${item.taskId}`}
            className={cn(
              "truncate font-medium text-[13.5px] text-sym-text hover:underline",
              item.archived && "text-sym-muted line-through",
            )}
          >
            {item.title}
          </Link>
          <span className="text-[12px] text-sym-muted">
            {item.deadline?.kind === "date"
              ? "All day"
              : item.deadlineAt !== null
                ? deliveryLabel(item.deadlineAt, zone)
                : "No deadline"}
            {stateWord[state] ? ` · ${stateWord[state]}` : ""}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={item.archived}
          onClick={() => setEditing({ taskId: item.taskId })}
        >
          {/* The visible label is short; the name a screen reader hears says which task it changes,
              because a month of these buttons would otherwise all be called the same thing. */}
          <span aria-hidden="true">Change date</span>
          <span className="sr-only">Change date for {item.title}</span>
        </Button>
      </li>
    );
  };

  return (
    <section
      className="flex h-full flex-col gap-4 overflow-auto px-6 py-5 max-md:px-3.5 max-md:py-4"
      aria-labelledby="calendar-title"
    >
      <header className="flex shrink-0 flex-col gap-1">
        <h1
          id="calendar-title"
          className="m-0 font-heading font-semibold text-[20px] tracking-[-0.01em]"
        >
          Calendar
        </h1>
        <p className="m-0 text-[13px] text-sym-muted">
          Task deadlines · {zone}. No connected calendar required.
        </p>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            size="icon"
            aria-label={`Previous ${step}`}
            onClick={() => shiftRange(-1)}
          >
            <ChevronLeft size={16} strokeWidth={2.2} aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            aria-label={`Next ${step}`}
            onClick={() => shiftRange(1)}
          >
            <ChevronRight size={16} strokeWidth={2.2} aria-hidden="true" />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => navigateDate(today)}>
            Today
          </Button>
        </div>
        {/* At phone width the range takes its own line, so the nav and the view switcher stay side by
            side instead of squeezing the title into a column. */}
        {/* `whitespace-nowrap` because the title is one short phrase and wrapping it mid-toolbar —
            "September" above "2026" — reads as a layout fault. The row wraps instead. */}
        <h2 className="m-0 min-w-0 flex-1 whitespace-nowrap font-heading font-semibold text-[15px] max-md:order-first max-md:basis-full">
          {title}
        </h2>
        {busy && loaded ? (
          <span className="flex items-center gap-1.5 text-[12px] text-sym-muted">
            <Spinner />
            Updating…
          </span>
        ) : null}
        <fieldset className="m-0 flex items-center gap-0.5 rounded-sym border border-sym-line bg-sym-panel p-0.5">
          <legend className="sr-only">Calendar view</legend>
          {calendarViews.map((mode) => (
            <Button
              key={mode}
              variant="ghost"
              size="sm"
              aria-pressed={view === mode}
              className={cn(view === mode && "bg-sym-surface text-sym-text")}
              onClick={() => {
                setView(mode);
                navigateDate(date, mode);
              }}
            >
              {viewLabel[mode]}
            </Button>
          ))}
        </fieldset>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-[13px] text-sym-muted">
          Collection
          <select
            className="h-8 rounded-sym border border-sym-line-strong bg-sym-surface px-2 text-[13.5px] text-sym-text"
            value={collection}
            onChange={(event) => setCollection(event.target.value as typeof collection)}
          >
            <option value="all">All collections</option>
            <option value="now">Now</option>
            <option value="later">Later</option>
            <option value="unclassified">Unclassified</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />
          Include completed
        </label>
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={unscheduled}
          className={cn(unscheduled && "bg-sym-hover")}
          onClick={() => setUnscheduled(!unscheduled)}
        >
          Without a date
        </Button>
      </div>

      <p className="sr-only" role="status">
        {/* "shown in" rather than "in": a month grid draws the whole weeks the month touches, so the
            count can include a deadline on a day either side of the month the title names. */}
        {busy
          ? "Loading deadlines…"
          : `${items.length} deadline${items.length === 1 ? "" : "s"} shown in ${title}`}
      </p>

      {error ? (
        <InlineError
          title="Couldn't load the calendar"
          description={error}
          onRetry={() => setRevision((count) => count + 1)}
        />
      ) : null}

      {loaded ? null : (
        <p className="m-0 flex items-center gap-2 text-[13px] text-sym-muted" role="status">
          <Spinner />
          Loading calendar…
        </p>
      )}

      {loaded && !error && !items.length && !listMode ? (
        <p className="m-0 text-[13px] text-sym-muted">
          No deadlines in this range. Dates are optional.
        </p>
      ) : null}

      {loaded && !error && !items.length && listMode ? (
        <EmptyState
          align="center"
          illustration={<ThemeIllustration />}
          title={unscheduled ? "Every task has a deadline" : "No deadlines in this range"}
          description={
            unscheduled
              ? "Nothing in this collection is waiting for a date."
              : "Dates are optional — a task is a task without one."
          }
        />
      ) : null}

      {showData && listMode && items.length ? (
        <div className="flex max-w-[760px] shrink-0 flex-col gap-5" aria-busy={busy || undefined}>
          {/* Each day is a heading and a list rather than a labelled region: the day panel under the
              grid is the one part of the calendar worth landmarking. */}
          {orderedDays(byDay).map(([day, entries]) => (
            <div key={day}>
              <h3 className="m-0 mb-1.5 font-heading font-semibold text-[13.5px]">
                {day === unscheduledDay ? "Without a date" : dayHeading(day, today)}
              </h3>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{entries.map(listEntry)}</ul>
            </div>
          ))}
        </div>
      ) : null}

      {showData && !listMode ? (
        <div className="shrink-0 overflow-hidden rounded-sym-lg border border-sym-line">
          <table
            ref={grid}
            aria-busy={busy || undefined}
            className="w-full table-fixed border-collapse"
          >
            <caption className="sr-only">{`Deadlines in ${title}`}</caption>
            <thead>
              <tr>
                {weekdayNames().map((weekday) => (
                  <th
                    key={weekday.long}
                    scope="col"
                    className="bg-sym-panel px-2 py-1.5 text-left font-medium text-[11.5px] text-sym-muted uppercase tracking-[0.04em]"
                  >
                    <span className="sr-only">{weekday.long}</span>
                    <span aria-hidden="true">{weekday.short}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeksOf(days).map((week) => (
                <tr key={week[0]}>
                  {week.map((day) => {
                    const entries = byDay.get(day) ?? [];
                    const hidden = Math.max(entries.length - limit, 0);
                    const outside = view !== "week" && day.slice(0, 7) !== date.slice(0, 7);
                    const selected = selectedDay === day;
                    return (
                      <td
                        key={day}
                        data-outside={outside}
                        className={cn(
                          "border-sym-line border-t border-r p-0 align-top last:border-r-0",
                          outside && "bg-sym-panel",
                          dropDay === day && "bg-sym-hover",
                        )}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                        }}
                        onDragEnter={() => setDropDay(day)}
                        onDragLeave={(event) => {
                          // `dragenter` and `dragleave` bubble, so crossing from the cell into one of its
                          // own entries fires a leave for the cell and the highlight flickers off and on
                          // under the pointer. It has only really left when the new target is outside.
                          const next = event.relatedTarget;
                          if (next instanceof Node && event.currentTarget.contains(next)) return;
                          setDropDay((current) => (current === day ? null : current));
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          setDropDay(null);
                          const taskId = event.dataTransfer.getData("application/x-symplist-task");
                          if (items.some((item) => item.taskId === taskId && !item.archived))
                            setEditing({ taskId, date: day });
                        }}
                      >
                        <div
                          className={cn(
                            "flex flex-col gap-1 p-1.5",
                            view === "week" ? "min-h-[200px]" : "min-h-16 md:min-h-[104px]",
                          )}
                        >
                          {/* The whole strip is the day's button at phone width, where the dots under
                              the number are all a cell can show; at desktop it is the number alone. */}
                          <button
                            type="button"
                            data-date={day}
                            tabIndex={day === tabDay ? 0 : -1}
                            aria-label={describeDay(day, entries.length)}
                            aria-expanded={selected}
                            {...(selected ? { "aria-controls": panelId } : {})}
                            {...(day === today ? { "aria-current": "date" as const } : {})}
                            className="group flex w-full cursor-pointer flex-col items-start gap-1 rounded-sym text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sym-focus md:w-auto md:self-start"
                            onClick={() => setSelectedDay(selected ? null : day)}
                            onFocus={() => setFocusedDate(day)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                setSelectedDay(null);
                                return;
                              }
                              if (event.key === "PageUp" || event.key === "PageDown") {
                                event.preventDefault();
                                movePage(day, event.key === "PageUp" ? -1 : 1);
                                return;
                              }
                              const column = days.indexOf(day) % 7;
                              const delta = {
                                ArrowLeft: -1,
                                ArrowRight: 1,
                                ArrowUp: -7,
                                ArrowDown: 7,
                                Home: -column,
                                End: 6 - column,
                              }[event.key];
                              if (delta === undefined) return;
                              event.preventDefault();
                              if (delta !== 0) moveFocus(day, delta);
                            }}
                          >
                            <span
                              className={cn(
                                "flex size-6 items-center justify-center rounded-full text-[12px] tabular-nums",
                                outside ? "text-sym-faint" : "text-sym-text",
                                day === today
                                  ? "bg-sym-ink font-semibold text-sym-on-ink"
                                  : "group-hover:bg-sym-hover",
                                selected && day !== today && "bg-sym-hover font-semibold",
                                selected && "ring-1 ring-sym-accent",
                              )}
                            >
                              {Number(day.slice(8))}
                            </span>
                            {entries.length ? (
                              // Decorative: the count is already in the button's accessible name, so a
                              // screen reader hears "3 deadlines" rather than counting dots.
                              <span
                                aria-hidden="true"
                                className="flex items-center gap-1 md:hidden"
                              >
                                {entries.slice(0, cellDotLimit).map((item) => (
                                  <span
                                    key={item.taskId}
                                    className={cn(
                                      "size-1.5 shrink-0 rounded-full",
                                      stateDot[deadlineState(item, now)],
                                    )}
                                  />
                                ))}
                                {entries.length > cellDotLimit ? (
                                  <span className="text-[10px] text-sym-muted leading-none tabular-nums">
                                    +{entries.length - cellDotLimit}
                                  </span>
                                ) : null}
                              </span>
                            ) : null}
                          </button>
                          <div className="hidden min-w-0 flex-col gap-0.5 md:flex">
                            {entries.slice(0, limit).map(cellEntry)}
                            {hidden ? (
                              <button
                                type="button"
                                aria-label={`Show all ${entries.length} deadlines on ${longDay(day)}`}
                                className="flex min-h-6 cursor-pointer items-center self-start rounded-sym px-1 text-[11px] text-sym-muted hover:bg-sym-hover hover:text-sym-text"
                                onClick={() => setSelectedDay(day)}
                              >
                                +{hidden} more
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {selectedDay && !listMode ? (
        <section
          id={panelId}
          ref={panel}
          // Focusable but not tabbable: the effect above puts focus here when the panel opens, and Escape
          // or Hide puts it back on the day. It never becomes an extra stop on the way through the page.
          tabIndex={-1}
          aria-label={`Deadlines on ${longDay(selectedDay)}`}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            closeDay(selectedDay);
          }}
          className="flex max-w-[760px] shrink-0 scroll-mt-2 flex-col gap-2 rounded-sym-lg border border-sym-line bg-sym-panel p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sym-focus"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 font-heading font-semibold text-[13.5px]">
              {dayHeading(selectedDay, today)}
            </h3>
            <Button variant="ghost" size="sm" onClick={() => closeDay(selectedDay)}>
              Hide
            </Button>
          </div>
          {byDay.get(selectedDay)?.length ? (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {(byDay.get(selectedDay) ?? []).map(listEntry)}
            </ul>
          ) : (
            <p className="m-0 text-[13px] text-sym-muted">No deadlines on this date.</p>
          )}
        </section>
      ) : null}

      {cursor && !busy ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const requestEpoch = epoch.current;
              setBusy(true);
              void api
                .calendar({ ...query, cursor })
                .then((result) => {
                  if (requestEpoch !== epoch.current) return;
                  setItems((previous) => [...previous, ...result.items]);
                  setCursor(result.nextCursor);
                })
                .catch((failure) => {
                  if (requestEpoch === epoch.current) setError(schedulingMessage(failure));
                })
                .finally(() => {
                  if (requestEpoch === epoch.current) setBusy(false);
                });
            }}
          >
            More tasks
          </Button>
        </div>
      ) : null}

      {editing ? (
        <ScheduleEditor
          taskId={editing.taskId}
          api={api}
          {...(editing.date ? { initialDate: editing.date } : {})}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setRevision((count) => count + 1);
          }}
        />
      ) : null}
    </section>
  );
}
