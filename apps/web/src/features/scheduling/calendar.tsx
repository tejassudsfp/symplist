"use client";
import type { SchedulingCalendarItem } from "@symplist/contracts";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { createSchedulingApi, type SchedulingApi, schedulingMessage } from "./api.ts";
import { ScheduleEditor } from "./schedule-editor.tsx";
import { deliveryLabel, localDate, shiftDate } from "./time-display.ts";

export function Calendar({ api: provided }: { api?: SchedulingApi }) {
  const api = useMemo(() => provided ?? createSchedulingApi(), [provided]);
  const [zone, setZone] = useState("UTC");
  const [ready, setReady] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [view, setView] = useState<"month" | "week" | "agenda">("month");
  const [collection, setCollection] = useState<"all" | "now" | "later" | "unclassified">("all");
  const [archived, setArchived] = useState(false);
  const [unscheduled, setUnscheduled] = useState(false);
  const [items, setItems] = useState<SchedulingCalendarItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<{ taskId: string; date?: string } | null>(null);
  const [focusedDate, setFocusedDate] = useState(date);
  const grid = useRef<HTMLTableElement>(null);
  const epoch = useRef(0);
  const restoreDayFocus = useRef(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setZone(browserZone);
    const fromUrl = params.get("date");
    const selected =
      fromUrl &&
      /^\d{4}-\d{2}-\d{2}$/.test(fromUrl) &&
      Number.isFinite(Date.parse(`${fromUrl}T12:00Z`)) &&
      new Date(`${fromUrl}T12:00Z`).toISOString().slice(0, 10) === fromUrl
        ? fromUrl
        : localDate(Date.now(), browserZone);
    setDate(selected);
    setFocusedDate(selected);
    const desiredView = params.get("view");
    if (desiredView === "week" || desiredView === "agenda" || desiredView === "month")
      setView(desiredView);
    else if (window.matchMedia("(max-width: 767px)").matches) setView("agenda");
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
    };
  }, [api]);
  const first =
    view === "week"
      ? shiftDate(date, -((new Date(`${date}T12:00Z`).getUTCDay() + 6) % 7))
      : `${date.slice(0, 7)}-01`;
  const nextMonth = new Date(`${first}T12:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
  const last =
    view === "week" ? shiftDate(first, 6) : shiftDate(nextMonth.toISOString().slice(0, 10), -1);
  const query = {
    from: first,
    to: last,
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
    setLoading(true);
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
        if (active) setError(schedulingMessage(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, queryKey, revision, ready]);
  useEffect(() => {
    if (!loading && restoreDayFocus.current) {
      restoreDayFocus.current = false;
      grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedDate}"]`)?.focus();
    }
  }, [loading, focusedDate]);
  const navigateDate = (next: string, nextView = view) => {
    setDate(next);
    setFocusedDate(next);
    window.history.replaceState(null, "", `/calendar?date=${next}&view=${nextView}`);
  };
  const shiftRange = (direction: number) => {
    if (view === "week") navigateDate(shiftDate(date, direction * 7));
    else {
      const next = new Date(`${first}T12:00Z`);
      next.setUTCMonth(next.getUTCMonth() + direction);
      navigateDate(next.toISOString().slice(0, 10));
    }
  };
  const byDay = new Map<string, SchedulingCalendarItem[]>();
  for (const item of items) {
    const day =
      item.deadline?.kind === "date"
        ? item.deadline.date
        : item.deadlineAt
          ? localDate(item.deadlineAt, zone)
          : "unscheduled";
    byDay.set(day, [...(byDay.get(day) ?? []), item]);
  }
  const gridStart =
    view === "week"
      ? first
      : shiftDate(first, -((new Date(`${first}T12:00Z`).getUTCDay() + 6) % 7));
  const days = Array.from({ length: view === "week" ? 7 : 42 }, (_, i) => shiftDate(gridStart, i));
  const entry = (item: SchedulingCalendarItem) => (
    <article
      key={item.taskId}
      className="sym-calendar-entry"
      data-completed={item.archived}
      draggable={!item.archived}
      onDragStart={(event) => {
        event.dataTransfer.setData("application/x-symplist-task", item.taskId);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <Link href={`/tasks/${item.taskId}`}>{item.title}</Link>
      <span>
        {item.deadline?.kind === "date"
          ? "All day"
          : item.deadlineAt
            ? deliveryLabel(item.deadlineAt, zone)
            : "No deadline"}
        {item.archived
          ? " · Completed"
          : item.deadlineAt !== null && item.deadlineAt < Date.now()
            ? " · Overdue"
            : ""}
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={item.archived}
        onClick={() => setEditing({ taskId: item.taskId })}
      >
        Change date
      </Button>
    </article>
  );
  return (
    <section className="sym-calendar" aria-labelledby="calendar-title">
      <header>
        <div>
          <h1 id="calendar-title">Calendar</h1>
          <p>Task deadlines · {zone}. No connected calendar required.</p>
        </div>
        <Button onClick={() => navigateDate(localDate(Date.now(), zone))}>Today</Button>
      </header>
      <div className="sym-calendar-toolbar">
        <Button aria-label="Previous range" onClick={() => shiftRange(-1)}>
          Previous
        </Button>
        <h2>
          {first} – {last}
        </h2>
        <Button aria-label="Next range" onClick={() => shiftRange(1)}>
          Next
        </Button>
        <fieldset className="sym-calendar-views" aria-label="Calendar view">
          {(["month", "week", "agenda"] as const).map((mode) => (
            <Button
              key={mode}
              aria-pressed={view === mode}
              onClick={() => {
                setView(mode);
                navigateDate(date, mode);
              }}
            >
              {mode[0]?.toUpperCase()}
              {mode.slice(1)}
            </Button>
          ))}
        </fieldset>
      </div>
      <div className="sym-calendar-filters">
        <label>
          Collection
          <select
            value={collection}
            onChange={(e) => setCollection(e.target.value as typeof collection)}
          >
            <option value="all">All collections</option>
            <option value="now">Now</option>
            <option value="later">Later</option>
            <option value="unclassified">Unclassified</option>
          </select>
        </label>
        <label className="sym-schedule-check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Include completed
        </label>
        <Button aria-pressed={unscheduled} onClick={() => setUnscheduled(!unscheduled)}>
          {unscheduled ? "Back to deadlines" : "Unscheduled tasks"}
        </Button>
      </div>
      {loading ? (
        <p role="status">Loading calendar…</p>
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <Button onClick={() => setRevision((n) => n + 1)}>Try again</Button>
        </div>
      ) : !items.length ? (
        <p className="sym-schedule-empty">
          {unscheduled
            ? "Every task in this collection has a deadline."
            : "No deadlines in this range. Dates are optional."}
        </p>
      ) : null}
      {!loading && !error && (view === "agenda" || unscheduled) ? (
        <div className="sym-calendar-agenda">
          {[...byDay.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, entries]) => (
              <section key={day}>
                <h3>{day === "unscheduled" ? "Unscheduled" : day}</h3>
                {entries.map(entry)}
              </section>
            ))}
        </div>
      ) : null}
      {!loading && !error && view !== "agenda" && !unscheduled ? (
        <table className="sym-calendar-grid" ref={grid} aria-label={`${view} deadlines`}>
          <thead>
            <tr className="sym-calendar-weekdays">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
                <th scope="col" key={day}>
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: days.length / 7 }, (_, week) => (
              <tr className="sym-calendar-week" key={days[week * 7]}>
                {days.slice(week * 7, week * 7 + 7).map((day) => (
                  <td
                    key={day}
                    className="sym-calendar-day"
                    data-outside={day.slice(0, 7) !== date.slice(0, 7)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const taskId = event.dataTransfer.getData("application/x-symplist-task");
                      if (items.some((item) => item.taskId === taskId && !item.archived))
                        setEditing({ taskId, date: day });
                    }}
                  >
                    <button
                      type="button"
                      data-date={day}
                      tabIndex={
                        day === focusedDate || (!days.includes(focusedDate) && day === first)
                          ? 0
                          : -1
                      }
                      aria-label={day}
                      aria-pressed={selectedDay === day}
                      onClick={() => setSelectedDay(day)}
                      onFocus={() => setFocusedDate(day)}
                      onKeyDown={(event) => {
                        const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[
                          event.key
                        ];
                        if (!delta) return;
                        event.preventDefault();
                        const next = shiftDate(day, delta);
                        if (days.includes(next)) {
                          setFocusedDate(next);
                          grid.current
                            ?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)
                            ?.focus();
                        } else {
                          restoreDayFocus.current = true;
                          navigateDate(next);
                        }
                      }}
                    >
                      {Number(day.slice(8))}
                    </button>
                    {(byDay.get(day) ?? [])
                      .sort(
                        (a, b) =>
                          (a.deadline?.kind === "date" ? 0 : 1) -
                            (b.deadline?.kind === "date" ? 0 : 1) ||
                          (a.deadlineAt ?? 0) - (b.deadlineAt ?? 0),
                      )
                      .map(entry)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {selectedDay && view !== "agenda" ? (
        <section aria-label={`Selected date ${selectedDay}`}>
          <h3>{selectedDay}</h3>
          {(byDay.get(selectedDay) ?? []).map(entry)}
          {!byDay.has(selectedDay) ? <p>No deadlines on this date.</p> : null}
        </section>
      ) : null}
      {cursor && !loading ? (
        <Button
          onClick={() => {
            const requestEpoch = epoch.current;
            setLoading(true);
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
                if (requestEpoch === epoch.current) setLoading(false);
              });
          }}
        >
          More tasks
        </Button>
      ) : null}
      {editing ? (
        <ScheduleEditor
          taskId={editing.taskId}
          api={api}
          {...(editing.date ? { initialDate: editing.date } : {})}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setRevision((n) => n + 1);
          }}
        />
      ) : null}
    </section>
  );
}
