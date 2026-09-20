"use client";

import {
  type AnalyticsEventProperties,
  type ClientAnalyticsEventName,
  isExcludedAnalyticsPath,
  validateAnalyticsEvent,
} from "@symplist/analytics";
import { type AnalyticsSettings, analyticsSettingsSchema } from "@symplist/contracts";
import { registerSignOutCleanup } from "@/features/access/sign-out";
import { setSearchUsedReporter } from "@/features/search/telemetry";
import { setAppearanceReporter } from "@/features/workspace/telemetry";
import { getApiClient } from "@/lib/api";

export interface AnalyticsSnapshot {
  readonly ownerId: string | null;
  readonly settings: AnalyticsSettings | null;
  readonly pending: boolean;
  readonly error: boolean;
  /** The choice whose write failed. Retained so a retry cannot invert a privacy withdrawal. */
  readonly failedChoice: "granted" | "denied" | null;
}
const initial: AnalyticsSnapshot = {
  ownerId: null,
  settings: null,
  pending: false,
  error: false,
  failedChoice: null,
};
let snapshot = initial;
let generation = 0;
const listeners = new Set<() => void>();
function publish(next: AnalyticsSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}
export function analyticsSnapshot() {
  return snapshot;
}
export function analyticsServerSnapshot() {
  return initial;
}
export function subscribeAnalytics(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function resetAnalytics() {
  generation += 1;
  publish(initial);
}
registerSignOutCleanup(resetAnalytics);
setSearchUsedReporter((event) => track("search_used", event));
setAppearanceReporter((event) => track("appearance_changed", event));

export async function loadAnalytics(ownerId: string): Promise<void> {
  if (snapshot.ownerId === ownerId && (snapshot.pending || snapshot.settings)) return;
  const token = ++generation;
  publish({ ownerId, settings: null, pending: true, error: false, failedChoice: null });
  try {
    const settings = await getApiClient().get("/v1/analytics/consent", {
      schema: analyticsSettingsSchema,
    });
    if (token === generation)
      publish({ ownerId, settings, pending: false, error: false, failedChoice: null });
  } catch {
    if (token === generation)
      publish({ ownerId, settings: null, pending: false, error: true, failedChoice: null });
  }
}

export async function chooseAnalytics(state: "granted" | "denied"): Promise<void> {
  if (!snapshot.ownerId || snapshot.pending) return;
  const token = ++generation;
  const before = snapshot;
  // Stop browser sends immediately while withdrawing; never replay pre-consent events.
  publish({
    ...before,
    pending: true,
    error: false,
    failedChoice: null,
    settings:
      state === "denied" && before.settings
        ? { ...before.settings, consent: { state: "denied", decidedAt: Date.now() } }
        : before.settings,
  });
  try {
    const settings = await getApiClient().put("/v1/analytics/consent", {
      body: { state },
      schema: analyticsSettingsSchema,
    });
    if (token === generation)
      publish({ ...before, settings, pending: false, error: false, failedChoice: null });
  } catch {
    if (token === generation)
      publish({
        ...(before.settings?.consent.state === "unset" ? before : snapshot),
        pending: false,
        error: true,
        failedChoice: state,
      });
  }
}

/** No browser SDK, storage, identity or offline queue. R9 keeps identity exclusively server-side. */
export function track<Name extends ClientAnalyticsEventName>(
  name: Name,
  properties: AnalyticsEventProperties<Name>,
): void {
  if (
    !snapshot.settings?.enabled ||
    snapshot.settings.consent.state !== "granted" ||
    snapshot.pending ||
    isExcludedAnalyticsPath(window.location.pathname)
  )
    return;
  if (!validateAnalyticsEvent("client", name, properties).ok) return;
  void getApiClient()
    .post("/v1/analytics/events", {
      body: { event: name, eventId: crypto.randomUUID(), properties },
    })
    .catch(() => undefined);
}
