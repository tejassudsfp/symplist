"use client";

import { Spinner } from "./spinner.tsx";

/**
 * Truthful save states (sample state transitions): "Saved" appears only after the save is confirmed,
 * and a failure keeps the draft with a Retry.
 */
export type SaveState =
  | { readonly kind: "saved"; readonly at: Date }
  | { readonly kind: "unsaved" }
  | { readonly kind: "saving" }
  | { readonly kind: "failed"; readonly onRetry: () => void };

export function formatSavedTime(at: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(at);
}

export function saveStatusText(state: SaveState, locale?: string): string {
  switch (state.kind) {
    case "saved":
      return `Saved ${formatSavedTime(state.at, locale)}`;
    case "unsaved":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    case "failed":
      return "Couldn't save — draft kept";
  }
}

export function SaveStatus({ state, locale }: { state: SaveState; locale?: string }) {
  return (
    <span role="status" aria-live="polite" data-state={state.kind} className="sym-save-status">
      {state.kind === "saving" ? <Spinner size={9} /> : null}
      {saveStatusText(state, locale)}
      {state.kind === "failed" ? (
        <button type="button" className="sym-text-button" onClick={state.onRetry}>
          Retry
        </button>
      ) : null}
    </span>
  );
}
