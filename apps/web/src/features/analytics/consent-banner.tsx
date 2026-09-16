"use client";

import { isExcludedAnalyticsPath } from "@symplist/analytics";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/features/access/session";
import {
  analyticsServerSnapshot,
  analyticsSnapshot,
  chooseAnalytics,
  loadAnalytics,
  resetAnalytics,
  subscribeAnalytics,
} from "./runtime.ts";

export function useAnalyticsConsent() {
  const { user, status } = useSession();
  const pathname = usePathname();
  const state = useSyncExternalStore(
    subscribeAnalytics,
    analyticsSnapshot,
    analyticsServerSnapshot,
  );
  useEffect(() => {
    if (status !== "signed_in" || !user) {
      resetAnalytics();
      return;
    }
    if (!isExcludedAnalyticsPath(pathname)) void loadAnalytics(user.id);
  }, [status, user?.id, pathname, user]);
  return state.ownerId === user?.id ? state : { ...state, settings: null };
}

export function ConsentBanner() {
  const state = useAnalyticsConsent();
  if (state.ownerId && !state.settings && state.error)
    return (
      <section className="sym-consent-banner" aria-label="Product analytics choice">
        <p role="alert">
          Your privacy choice could not be loaded. Product usage sharing stays off.
        </p>
        <Button variant="secondary" onClick={() => void loadAnalytics(state.ownerId ?? "")}>
          Try again
        </Button>
      </section>
    );
  if (!state.settings?.enabled || state.settings.consent.state !== "unset") return null;
  return (
    <section className="sym-consent-banner" aria-labelledby="consent-title">
      <div>
        <h2 id="consent-title">Help make Symplist simpler?</h2>
        <p>
          Allow optional product usage analytics with PostHog (US). No private content, browsing
          history or session replay. <a href="/privacy">Privacy notice</a>
        </p>
        {state.error && <p role="alert">Your choice could not be saved. Please try again.</p>}
      </div>
      <div className="sym-sharing-buttons">
        <Button
          variant="secondary"
          disabled={state.pending}
          onClick={() => void chooseAnalytics("denied")}
        >
          Decline
        </Button>
        <Button
          variant="secondary"
          disabled={state.pending}
          onClick={() => void chooseAnalytics("granted")}
        >
          Accept
        </Button>
      </div>
    </section>
  );
}
