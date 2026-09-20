"use client";
import { Button } from "@/components/ui/button";
import { useAnalyticsConsent } from "./consent-banner.tsx";
import { chooseAnalytics, loadAnalytics } from "./runtime.ts";

export function PrivacySettings() {
  const state = useAnalyticsConsent();
  return (
    <section aria-labelledby="privacy-title" className="sym-privacy-settings">
      <h2 id="privacy-title">Privacy</h2>
      <p>
        Optional product usage helps improve Symplist. We measure categories of actions, never task
        text, documents, chats, searches or Vault contents. No session replay.{" "}
        <a href="/privacy">Privacy notice</a>
      </p>
      {state.settings ? (
        state.settings.enabled ? (
          <label>
            <input
              type="checkbox"
              checked={state.settings.consent.state === "granted"}
              disabled={state.pending}
              onChange={(event) =>
                void chooseAnalytics(event.target.checked ? "granted" : "denied")
              }
            />
            Share product usage
          </label>
        ) : (
          <p>Product analytics is disabled for this deployment.</p>
        )
      ) : (
        <p role="status">
          {state.error ? "Privacy settings could not be loaded." : "Loading privacy settings…"}
        </p>
      )}
      {state.error && (
        <div role="alert">
          Your choice may not have been saved.
          {!state.settings && state.ownerId && (
            <Button variant="secondary" onClick={() => void loadAnalytics(state.ownerId ?? "")}>
              Try again
            </Button>
          )}
          {state.settings && state.failedChoice && (
            <Button
              variant="secondary"
              disabled={state.pending}
              onClick={() => void chooseAnalytics(state.failedChoice ?? "denied")}
            >
              {state.failedChoice === "denied"
                ? "Retry turning off analytics"
                : "Retry turning on analytics"}
            </Button>
          )}
        </div>
      )}
      {state.pending && state.settings && <p role="status">Saving…</p>}
      {state.settings?.consent.state === "denied" && !state.pending && !state.error && (
        <p role="status">Product usage sharing is off. Tasks, Simon and reminders are unchanged.</p>
      )}
    </section>
  );
}
