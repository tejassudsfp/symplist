"use client";
import {
  type SchedulingPreferences,
  type SchedulingReminderInput,
  type SchedulingSave,
  type SchedulingSnapshot,
  schedulingDefaultPreferences,
} from "@symplist/contracts";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { type SchedulingApi, schedulingMessage } from "./api.ts";
import {
  daylightChoice,
  deliveryLabel,
  localDate,
  schedulingHours,
  schedulingZones,
  shiftDate,
} from "./time-display.ts";

export function ScheduleEditor({
  taskId,
  api,
  onClose,
  onSaved,
  addReminder = false,
  initialDate,
}: {
  taskId: string;
  api: SchedulingApi;
  onClose: () => void;
  onSaved: (snapshot: SchedulingSnapshot) => void;
  addReminder?: boolean;
  initialDate?: string;
}) {
  const [data, setData] = useState<SchedulingSave | null>(null);
  const [prefs, setPrefs] = useState<SchedulingPreferences>(schedulingDefaultPreferences);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [preview, setPreview] = useState<Awaited<ReturnType<SchedulingApi["preview"]>> | null>(
    null,
  );
  const [removeRelative, setRemoveRelative] = useState(false);
  const request = useRef<{ json: string; key: string } | null>(null);
  const initialFocus = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void reload;
    let active = true;
    setError("");
    setData(null);
    void Promise.all([api.get(taskId), api.preferences()])
      .then(([snapshot, preferences]) => {
        if (!active) return;
        setPrefs(preferences.data);
        const reminders = snapshot.reminders.map(({ id, rule, channels, overrideQuiet }) => ({
          id,
          rule,
          channels,
          overrideQuiet,
        }));
        if (addReminder)
          reminders.push(newReminder(preferences.data) as (typeof reminders)[number]);
        setData({
          baseVersion: snapshot.version,
          deadline: initialDate
            ? snapshot.deadline?.kind === "timed"
              ? {
                  ...snapshot.deadline,
                  local: `${initialDate}${snapshot.deadline.local.slice(10)}`,
                }
              : {
                  kind: "date",
                  date: initialDate,
                  zone: snapshot.deadline?.zone ?? preferences.data.zone,
                }
            : snapshot.deadline,
          reminders,
        });
      })
      .catch((failure) => {
        if (active) setError(schedulingMessage(failure));
      });
    return () => {
      active = false;
    };
  }, [api, taskId, reload, addReminder, initialDate]);
  const update = (next: SchedulingSave) => {
    setData(next);
    setPreview(null);
    setError("");
  };
  const save = async () => {
    if (!data) return;
    const json = JSON.stringify(data);
    if (request.current?.json !== json) request.current = { json, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const result = await api.save(taskId, data, request.current.key);
      onSaved(result);
      onClose();
    } catch (failure) {
      setError(schedulingMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const showPreview = async () => {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      setPreview(await api.preview(data));
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
      <DialogContent className="sym-schedule-editor" initialFocus={initialFocus}>
        <DialogTitle>Deadline and reminders</DialogTitle>
        <DialogDescription>
          Optional dates, without moving the task. Reminders arrive at the top of the local hour.
        </DialogDescription>
        {!data && !error ? <p role="status">Loading schedule…</p> : null}
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <Button onClick={() => setReload((n) => n + 1)} disabled={busy}>
              Reload schedule
            </Button>
          </div>
        ) : null}
        {data ? (
          <fieldset className="sym-schedule-fields" disabled={busy}>
            <legend className="sr-only">Schedule details</legend>
            <label>
              Deadline date
              <input
                ref={initialFocus}
                type="date"
                value={
                  data.deadline?.kind === "date"
                    ? data.deadline.date
                    : (data.deadline?.local.slice(0, 10) ?? "")
                }
                onChange={(e) => {
                  const date = e.target.value;
                  if (!date) {
                    if (data.reminders.some((r) => r.rule.kind !== "absolute"))
                      setRemoveRelative(true);
                    else update({ ...data, deadline: null });
                  } else
                    update({
                      ...data,
                      deadline:
                        data.deadline?.kind === "timed"
                          ? { ...data.deadline, local: `${date}${data.deadline.local.slice(10)}` }
                          : { kind: "date", date, zone: data.deadline?.zone ?? prefs.zone },
                    });
                }}
              />
            </label>
            {data.deadline ? (
              <>
                <label className="sym-schedule-check">
                  <input
                    type="checkbox"
                    checked={data.deadline.kind === "timed"}
                    onChange={(e) => {
                      const deadline = data.deadline;
                      if (!deadline) return;
                      const date =
                        deadline.kind === "date" ? deadline.date : deadline.local.slice(0, 10);
                      update({
                        ...data,
                        deadline: e.target.checked
                          ? {
                              kind: "timed",
                              local: `${date}T${String(prefs.defaultHour).padStart(2, "0")}:00`,
                              zone: deadline.zone,
                              disambiguation: "reject",
                            }
                          : { kind: "date", date, zone: deadline.zone },
                      });
                    }}
                  />
                  Exact time
                </label>
                {data.deadline.kind === "timed" ? (
                  <label>
                    Deadline time
                    <input
                      type="time"
                      value={data.deadline.local.slice(11)}
                      onChange={(e) => {
                        if (data.deadline?.kind === "timed")
                          update({
                            ...data,
                            deadline: {
                              ...data.deadline,
                              local: `${data.deadline.local.slice(0, 11)}${e.target.value}`,
                            },
                          });
                      }}
                    />
                  </label>
                ) : null}
                <label>
                  Deadline timezone
                  <input
                    list="schedule-zones"
                    value={data.deadline.zone}
                    onChange={(e) => {
                      if (data.deadline)
                        update({ ...data, deadline: { ...data.deadline, zone: e.target.value } });
                    }}
                  />
                </label>
                {data.deadline.kind === "timed" ? (
                  <label>
                    Daylight-saving choice
                    <select
                      value={data.deadline.disambiguation}
                      onChange={(e) => {
                        if (data.deadline?.kind === "timed")
                          update({
                            ...data,
                            deadline: {
                              ...data.deadline,
                              disambiguation: e.target.value as "reject" | "earlier" | "later",
                            },
                          });
                      }}
                    >
                      <option value="reject">Ask if time is skipped or repeated</option>
                      <option value="earlier">
                        {daylightChoice(data.deadline.local, data.deadline.zone, "earlier")}
                      </option>
                      <option value="later">
                        {daylightChoice(data.deadline.local, data.deadline.zone, "later")}
                      </option>
                    </select>
                  </label>
                ) : null}
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (data.reminders.some((r) => r.rule.kind !== "absolute"))
                      setRemoveRelative(true);
                    else update({ ...data, deadline: null });
                  }}
                >
                  Clear deadline
                </Button>
              </>
            ) : (
              <p className="sym-schedule-muted">
                No deadline. A standalone reminder is still available.
              </p>
            )}
            {removeRelative ? (
              <fieldset className="sym-schedule-notice" aria-label="Remove relative reminders">
                <p>
                  Removing this deadline also removes reminders tied to it. Custom reminders stay.
                </p>
                <Button
                  onClick={() => {
                    update({
                      ...data,
                      deadline: null,
                      reminders: data.reminders.filter((r) => r.rule.kind === "absolute"),
                    });
                    setRemoveRelative(false);
                  }}
                >
                  Remove deadline and relative reminders
                </Button>
                <Button variant="ghost" onClick={() => setRemoveRelative(false)}>
                  Keep deadline
                </Button>
              </fieldset>
            ) : null}
            <h3>Reminders</h3>
            {data.reminders.length === 0 ? (
              <p className="sym-schedule-muted">
                None scheduled. We never add a reminder automatically.
              </p>
            ) : null}
            {data.reminders.map((reminder, index) => (
              <ReminderFields
                key={reminder.id ?? `new-${index}`}
                value={reminder}
                index={index}
                prefs={prefs}
                hasDeadline={data.deadline !== null}
                timed={data.deadline?.kind === "timed"}
                onChange={(next) =>
                  update({
                    ...data,
                    reminders: data.reminders.map((r, i) => (i === index ? next : r)),
                  })
                }
                onRemove={() =>
                  update({ ...data, reminders: data.reminders.filter((_, i) => i !== index) })
                }
              />
            ))}
            <Button
              onClick={() =>
                update({ ...data, reminders: [...data.reminders, newReminder(prefs)] })
              }
              disabled={data.reminders.length >= 20}
            >
              Add reminder
            </Button>
            <datalist id="schedule-zones">
              {schedulingZones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <Button variant="secondary" onClick={() => void showPreview()} disabled={busy}>
              Preview delivery times
            </Button>
            {preview ? (
              <div role="status" className="sym-schedule-preview">
                {preview.reminders.map((reminder, index) => (
                  <p key={reminder.id ?? JSON.stringify(reminder)}>
                    Reminder {index + 1}:{" "}
                    {deliveryLabel(
                      reminder.intendedAt,
                      reminder.rule.kind === "absolute"
                        ? reminder.rule.zone
                        : (data.deadline?.zone ?? prefs.zone),
                    )}
                    {reminder.channels.includes("email") &&
                    reminder.emailAt !== reminder.intendedAt ? (
                      <>
                        <br />
                        Email waits until {deliveryLabel(reminder.emailAt, prefs.zone)} for quiet
                        hours.
                      </>
                    ) : null}
                    {reminder.crossesDeadline ? (
                      <>
                        <br />
                        Email arrives after the deadline.
                      </>
                    ) : null}
                  </p>
                ))}
                {preview.reminders.length === 0 ? <p>No reminders will be sent.</p> : null}
              </div>
            ) : null}
          </fieldset>
        ) : null}
        <DialogActions>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={busy || !data || removeRelative || (data.reminders.length > 0 && !preview)}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogActions>
        {data?.reminders.length && !preview ? (
          <p className="sym-schedule-muted">Preview delivery times before saving reminders.</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function newReminder(prefs: SchedulingPreferences): SchedulingReminderInput {
  return {
    rule: {
      kind: "absolute",
      local: `${shiftDate(localDate(Date.now(), prefs.zone), 1)}T${String(prefs.defaultHour).padStart(2, "0")}:00`,
      zone: prefs.zone,
      disambiguation: "reject",
    },
    channels: ["in_app"],
    overrideQuiet: false,
  };
}
function ReminderFields({
  value,
  index,
  prefs,
  hasDeadline,
  timed,
  onChange,
  onRemove,
}: {
  value: SchedulingReminderInput;
  index: number;
  prefs: SchedulingPreferences;
  hasDeadline: boolean;
  timed: boolean;
  onChange: (next: SchedulingReminderInput) => void;
  onRemove: () => void;
}) {
  const preset =
    value.rule.kind === "absolute"
      ? "custom"
      : value.rule.kind === "elapsed"
        ? value.rule.minutesBefore === 0
          ? "at"
          : "hour"
        : value.rule.daysBefore === 0
          ? "day"
          : "previous";
  return (
    <fieldset className="sym-reminder-fields">
      <legend>Reminder {index + 1}</legend>
      <label>
        When
        <select
          value={preset}
          onChange={(e) => {
            const selected = e.target.value;
            onChange({
              ...value,
              rule:
                selected === "custom"
                  ? newReminder(prefs).rule
                  : selected === "at" || selected === "hour"
                    ? { kind: "elapsed", minutesBefore: selected === "at" ? 0 : 60 }
                    : {
                        kind: "calendar",
                        daysBefore: selected === "day" ? 0 : 1,
                        hour: prefs.defaultHour,
                      },
            });
          }}
        >
          <option value="custom">Custom time</option>
          {timed ? (
            <>
              <option value="at">At deadline</option>
              <option value="hour">One hour before</option>
            </>
          ) : null}
          {hasDeadline ? (
            <>
              <option value="day">On the day</option>
              <option value="previous">Previous day</option>
            </>
          ) : null}
        </select>
      </label>
      {value.rule.kind === "calendar" ? (
        <label>
          Reminder hour
          <select
            value={value.rule.hour}
            onChange={(e) => {
              if (value.rule.kind === "calendar")
                onChange({ ...value, rule: { ...value.rule, hour: Number(e.target.value) } });
            }}
          >
            {schedulingHours.map((hour) => (
              <option key={hour} value={hour}>
                {String(hour).padStart(2, "0")}:00
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {value.rule.kind === "absolute" ? (
        <>
          <label>
            Custom reminder time
            <input
              type="datetime-local"
              step="3600"
              value={value.rule.local}
              onChange={(e) => {
                if (value.rule.kind === "absolute")
                  onChange({ ...value, rule: { ...value.rule, local: e.target.value } });
              }}
            />
          </label>
          <label>
            Reminder timezone
            <input
              list="schedule-zones"
              value={value.rule.zone}
              onChange={(e) => {
                if (value.rule.kind === "absolute")
                  onChange({ ...value, rule: { ...value.rule, zone: e.target.value } });
              }}
            />
          </label>
          <label>
            Daylight-saving choice
            <select
              value={value.rule.disambiguation}
              onChange={(e) => {
                if (value.rule.kind === "absolute")
                  onChange({
                    ...value,
                    rule: {
                      ...value.rule,
                      disambiguation: e.target.value as "reject" | "earlier" | "later",
                    },
                  });
              }}
            >
              <option value="reject">Ask if ambiguous</option>
              <option value="earlier">
                {daylightChoice(value.rule.local, value.rule.zone, "earlier")}
              </option>
              <option value="later">
                {daylightChoice(value.rule.local, value.rule.zone, "later")}
              </option>
            </select>
          </label>
        </>
      ) : null}
      <div className="sym-schedule-row">
        {(["in_app", "email"] as const).map((channel) => (
          <label className="sym-schedule-check" key={channel}>
            <input
              type="checkbox"
              checked={value.channels.includes(channel)}
              onChange={(e) =>
                onChange({
                  ...value,
                  channels: e.target.checked
                    ? [...value.channels, channel]
                    : value.channels.filter((item) => item !== channel),
                })
              }
            />
            {channel === "in_app" ? "In-app" : "Email"}
          </label>
        ))}
      </div>
      <label className="sym-schedule-check">
        <input
          type="checkbox"
          checked={value.overrideQuiet}
          onChange={(e) => onChange({ ...value, overrideQuiet: e.target.checked })}
        />
        Allow during quiet hours
      </label>
      <Button variant="ghost" onClick={onRemove}>
        Remove reminder {index + 1}
      </Button>
    </fieldset>
  );
}
