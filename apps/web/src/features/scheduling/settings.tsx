"use client";
import type { SchedulingPreferences } from "@symplist/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Temporal } from "temporal-polyfill";
import { Button } from "@/components/ui/button";
import { createSchedulingApi, type SchedulingApi, schedulingMessage } from "./api.ts";
import { deliveryLabel, schedulingHours, schedulingZones } from "./time-display.ts";

export function NotificationSettings({ api: provided }: { api?: SchedulingApi }) {
  const api = useMemo(() => provided ?? createSchedulingApi(), [provided]);
  const [state, setState] = useState<Awaited<ReturnType<SchedulingApi["preferences"]>> | null>(
    null,
  );
  const [data, setData] = useState<SchedulingPreferences | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const request = useRef<{ json: string; key: string } | null>(null);
  useEffect(() => {
    void reload;
    let active = true;
    setError("");
    void api
      .preferences()
      .then((result) => {
        if (active) {
          setState(result);
          setData(result.data);
        }
      })
      .catch((failure) => {
        if (active) setError(schedulingMessage(failure));
      });
    return () => {
      active = false;
    };
  }, [api, reload]);
  const change = (next: SchedulingPreferences) => {
    setData(next);
    setSaved(false);
  };
  const save = async () => {
    if (!data || !state) return;
    const json = JSON.stringify({ baseVersion: state.version, data });
    if (request.current?.json !== json) request.current = { json, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const result = await api.savePreferences(state.version, data, request.current.key);
      // Delivery health is read-only; saving timing preferences cannot clear a suppression.
      setState((previous) => ({
        ...result,
        deliveryTracking: previous?.deliveryTracking,
        addressSuppressed: previous?.addressSuppressed,
      }));
      setData(result.data);
      setSaved(true);
    } catch (failure) {
      setError(schedulingMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="sym-notification-settings" aria-labelledby="notification-settings-title">
      <h1 id="notification-settings-title">Notifications</h1>
      <p className="sym-schedule-muted">A quiet reminder, when you ask for one.</p>
      {!data && !error ? <p role="status">Loading notification settings…</p> : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button onClick={() => setReload((n) => n + 1)}>Reload settings</Button>
        </div>
      ) : null}
      {data && state ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="sym-schedule-fields"
        >
          <fieldset disabled={busy} className="sym-schedule-fields">
            <legend className="sr-only">Notification preferences</legend>
            {!state.remindersEnabled ? (
              <p className="sym-schedule-notice">
                All reminders are disabled on this server. Existing pending deliveries are
                cancelled.
              </p>
            ) : null}
            <label>
              Timezone
              <input
                list="notification-timezones"
                value={data.zone}
                onChange={(e) => change({ ...data, zone: e.target.value })}
              />
            </label>
            <datalist id="notification-timezones">
              {schedulingZones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <p className="sym-schedule-muted">
              This is the default for new schedules. Existing deadlines keep their timezone.
            </p>
            <p className="sym-schedule-preview">{nextDeliveryPreview(data)}</p>
            {state.deliveryTracking && state.addressSuppressed ? (
              <p role="status" className="sym-schedule-notice">
                Reminder email is paused for this address after a permanent bounce or complaint.
                Contact support before scheduling new email reminders. Sign-in and Vault-security
                emails use their own delivery rules.
              </p>
            ) : null}
            <label>
              Default reminder hour
              <select
                value={data.defaultHour}
                onChange={(e) => change({ ...data, defaultHour: Number(e.target.value) })}
              >
                {schedulingHours.map((hour) => (
                  <option key={hour} value={hour}>
                    {String(hour).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>Channels</legend>
              <label className="sym-schedule-check">
                <input
                  type="checkbox"
                  checked={data.inApp}
                  onChange={(e) => change({ ...data, inApp: e.target.checked })}
                />
                In-app notifications
              </label>
              <label className="sym-schedule-check">
                <input
                  type="checkbox"
                  checked={data.email}
                  disabled={!state.emailEnabled}
                  onChange={(e) => change({ ...data, email: e.target.checked })}
                />
                Reminder email
              </label>
              {!state.emailEnabled ? <p>Email reminders are disabled on this server.</p> : null}
              <p className="sym-schedule-muted">
                Turning a channel off cancels its pending reminders. Turning it back on does not
                resend them.
              </p>
            </fieldset>
            <fieldset>
              <legend>Quiet hours</legend>
              <label className="sym-schedule-check">
                <input
                  type="checkbox"
                  checked={data.quietEnabled}
                  onChange={(e) => change({ ...data, quietEnabled: e.target.checked })}
                />
                Use quiet hours
              </label>
              <div className="sym-schedule-row">
                {(["quietStart", "quietEnd"] as const).map((field) => (
                  <label key={field}>
                    {field === "quietStart" ? "Start hour" : "End hour"}
                    <select
                      disabled={!data.quietEnabled}
                      value={data[field]}
                      onChange={(e) => change({ ...data, [field]: Number(e.target.value) })}
                    >
                      {schedulingHours.map((hour) => (
                        <option key={hour} value={hour}>
                          {String(hour).padStart(2, "0")}:00
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p className="sym-schedule-muted">
                In-app reminders stay in the center without a toast. Email waits until quiet hours
                end, followed by one summary.
              </p>
            </fieldset>
            <fieldset>
              <legend>Email privacy</legend>
              <label className="sym-schedule-check">
                <input
                  type="checkbox"
                  checked={data.emailPreview}
                  onChange={(e) => change({ ...data, emailPreview: e.target.checked })}
                />
                Include task titles in reminder emails
              </label>
              <div className="sym-schedule-preview">
                <strong>
                  {data.emailPreview
                    ? "Reminder: Draft the project outline"
                    : "You have a task reminder"}
                </strong>
                <p>
                  {data.emailPreview
                    ? "Your task title will be visible to your email provider and in your inbox."
                    : "No task title, document text, chat, or Vault content is included."}
                </p>
              </div>
            </fieldset>
            <p>Reminder preferences never disable sign-in, signup, or Vault-security emails.</p>
            {saved ? <p role="status">Notification settings saved.</p> : null}
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Saving…" : "Save settings"}
            </Button>
          </fieldset>
        </form>
      ) : null}
    </section>
  );
}

function nextDeliveryPreview(data: SchedulingPreferences): string {
  try {
    const now = Temporal.Now.zonedDateTimeISO(data.zone);
    let time = now.with({ hour: data.defaultHour, minute: 0, second: 0, millisecond: 0 });
    if (Temporal.ZonedDateTime.compare(time, now) <= 0) time = time.add({ days: 1 });
    const quiet = (hour: number) =>
      data.quietEnabled &&
      (data.quietStart < data.quietEnd
        ? hour >= data.quietStart && hour < data.quietEnd
        : hour >= data.quietStart || hour < data.quietEnd);
    let email = time;
    for (let index = 0; index < 48 && quiet(email.hour); index++) email = email.add({ hours: 1 });
    return `Next default hour: ${deliveryLabel(time.epochMilliseconds, data.zone)}.${data.email ? ` Email: ${deliveryLabel(email.epochMilliseconds, data.zone)}.` : " Reminder email is off."} This preview does not schedule a reminder.`;
  } catch {
    return "Choose a valid timezone to preview the next delivery.";
  }
}
