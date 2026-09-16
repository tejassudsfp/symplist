"use client";
import type { SchedulingNotification } from "@symplist/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { workspaceCommands } from "@/features/workspace/controller";
import { type SchedulingApi, schedulingMessage } from "./api.ts";
import { deliveryLabel, localDate, shiftDate } from "./time-display.ts";

export function NotificationCenter({
  api,
  onClose,
  onUnread,
  refreshRevision = 0,
}: {
  api: SchedulingApi;
  onClose: () => void;
  onUnread: (count: number) => void;
  refreshRevision?: number;
}) {
  const [items, setItems] = useState<SchedulingNotification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [snooze, setSnooze] = useState<SchedulingNotification | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const request = useRef(new Map<string, string>());
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const updateOnline = () => {
      setOffline(!navigator.onLine);
      if (navigator.onLine) setRevision((value) => value + 1);
    };
    setOffline(!navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      active.current = false;
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);
  const unread = useRef(onUnread);
  unread.current = onUnread;
  useEffect(() => {
    void revision;
    void refreshRevision;
    let current = true;
    setLoading(true);
    setError("");
    void api
      .notifications()
      .then((result) => {
        if (!current) return;
        setItems(result.items);
        setCursor(result.nextCursor);
        unread.current(result.unreadCount);
      })
      .catch((failure) => {
        if (current) setError(schedulingMessage(failure));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, revision, refreshRevision]);
  const keyFor = (intent: string) => {
    let key = request.current.get(intent);
    if (!key) {
      key = crypto.randomUUID();
      request.current.set(intent, key);
    }
    return key;
  };
  const mark = async (item: SchedulingNotification, action: "read" | "dismiss") => {
    setBusy(item.id);
    setError("");
    try {
      await api.mark(item.id, action, keyFor(`${item.id}:${action}`));
      if (active.current) setRevision((n) => n + 1);
    } catch (failure) {
      if (active.current) setError(schedulingMessage(failure));
    } finally {
      if (active.current) setBusy(null);
    }
  };
  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const result = await api.notifications(cursor);
      if (active.current) {
        setItems((previous) => [
          ...previous,
          ...result.items.filter((entry) => !previous.some((item) => item.id === entry.id)),
        ]);
        setCursor(result.nextCursor);
      }
    } catch (failure) {
      if (active.current) setError(schedulingMessage(failure));
    } finally {
      if (active.current) setLoading(false);
    }
  };
  const today = localDate(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  let previousDay = "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sym-notification-center">
        <DialogTitle>Notifications</DialogTitle>
        <DialogDescription>
          Reading or dismissing a reminder never completes its task.
        </DialogDescription>
        {offline ? (
          <p role="status">
            You’re offline. Saved reminders stay here; changes will be available when you reconnect.
          </p>
        ) : null}
        {loading && !items.length ? <p role="status">Loading reminders…</p> : null}
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <Button onClick={() => setRevision((n) => n + 1)}>Try again</Button>
          </div>
        ) : null}
        {!loading && !error && !items.length ? (
          <div className="sym-schedule-empty">
            <h3>All quiet here</h3>
            <p>Reminders you schedule will stay here, even while the app is closed.</p>
          </div>
        ) : null}
        <div className="sym-notification-list">
          {items.map((item) => {
            const day = localDate(item.createdAt, Intl.DateTimeFormat().resolvedOptions().timeZone);
            const heading = day !== previousDay;
            previousDay = day;
            return (
              <section className="sym-notification-group" key={item.id}>
                {heading ? <h3>{day === today ? "Today" : day}</h3> : null}
                <article className="sym-notification-entry" data-unread={item.readAt === null}>
                  <h4>{item.title}</h4>
                  <p className="sym-schedule-muted">
                    {item.deadline
                      ? `Deadline: ${item.deadline.kind === "date" ? item.deadline.date : item.deadline.local.replace("T", " at ")} · ${item.deadline.zone}`
                      : "No deadline"}
                  </p>
                  <p>
                    {item.kind === "missed"
                      ? `${item.count} missed reminder${item.count === 1 ? "" : "s"} · `
                      : ""}
                    {deliveryLabel(
                      item.intendedAt,
                      Intl.DateTimeFormat().resolvedOptions().timeZone,
                    )}
                  </p>
                  {item.quiet ? (
                    <p className="sym-schedule-muted">Quiet hours · saved without a toast</p>
                  ) : null}
                  {!item.taskActive ? <p>This task is completed or archived.</p> : null}
                  <div className="sym-notification-actions">
                    <Link href={`/tasks/${item.taskId}`} onClick={onClose}>
                      Open task
                    </Link>
                    <Button
                      size="sm"
                      disabled={!item.taskActive || busy !== null}
                      onClick={() => setSnooze(item)}
                    >
                      Snooze
                    </Button>
                    <Button
                      size="sm"
                      disabled={!item.taskActive || busy !== null}
                      onClick={() => {
                        onClose();
                        void workspaceCommands()?.commands.complete(item.taskId);
                      }}
                    >
                      Mark complete
                    </Button>
                    {item.readAt === null ? (
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void mark(item, "read")}
                      >
                        Mark read
                      </Button>
                    ) : (
                      <span className="sym-schedule-muted">Read</span>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void mark(item, "dismiss")}
                    >
                      Dismiss
                    </Button>
                  </div>
                </article>
              </section>
            );
          })}
        </div>
        {cursor ? (
          <Button disabled={loading} onClick={() => void loadMore()}>
            {loading ? "Loading…" : "More notifications"}
          </Button>
        ) : null}
        <DialogActions>
          <Link href="/settings/notifications" onClick={onClose}>
            Notification settings
          </Link>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
        {snooze ? (
          <SnoozeDialog
            item={snooze}
            api={api}
            onClose={() => setSnooze(null)}
            onSaved={() => {
              setSnooze(null);
              setRevision((n) => n + 1);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function SnoozeDialog({
  item,
  api,
  onClose,
  onSaved,
}: {
  item: SchedulingNotification;
  api: SchedulingApi;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [local, setLocal] = useState("");
  const [choice, setChoice] = useState<"reject" | "earlier" | "later">("reject");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<{ value: string; key: string } | null>(null);
  useEffect(() => {
    let current = true;
    void api
      .preferences()
      .then((state) => {
        if (current) setZone(state.data.zone);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [api]);
  const preset = (kind: "hour" | "tomorrow") => {
    if (kind === "tomorrow") setLocal(`${shiftDate(localDate(Date.now(), zone), 1)}T09:00`);
    else {
      const next = Date.now() + 3600000;
      const hour = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        hourCycle: "h23",
        timeZone: zone,
      }).format(next);
      setLocal(`${localDate(next, zone)}T${hour}:00`);
    }
  };
  const save = async () => {
    setBusy(true);
    setError("");
    const value = JSON.stringify({ local, zone, choice });
    if (request.current?.value !== value) request.current = { value, key: crypto.randomUUID() };
    try {
      await api.snooze(item.id, { local, zone, disambiguation: choice }, request.current.key);
      onSaved();
    } catch (failure) {
      setError(schedulingMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sym-snooze">
        <DialogTitle>Snooze reminder</DialogTitle>
        <DialogDescription>The deadline stays unchanged.</DialogDescription>
        <fieldset className="sym-schedule-fields" disabled={busy}>
          <legend className="sr-only">Snooze time</legend>
          <div className="sym-schedule-row">
            <Button onClick={() => preset("hour")}>1 hour</Button>
            <Button onClick={() => preset("tomorrow")}>Tomorrow at 9</Button>
          </div>
          <label>
            Custom hour
            <input
              type="datetime-local"
              step="3600"
              value={local}
              onChange={(e) => setLocal(e.target.value)}
            />
          </label>
          <label>
            Timezone
            <input type="text" value={zone} onChange={(e) => setZone(e.target.value)} />
          </label>
          <label>
            Daylight-saving choice
            <select value={choice} onChange={(e) => setChoice(e.target.value as typeof choice)}>
              <option value="reject">Ask if ambiguous</option>
              <option value="earlier">Earlier</option>
              <option value="later">Later</option>
            </select>
          </label>
          {local ? (
            <p>
              New reminder: {local.replace("T", " at ")} · {zone}. At the top of the hour.
            </p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
        </fieldset>
        <DialogActions>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!local || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Snooze"}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
