"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  type KeyboardPreferences,
  parseKeyboardPreferences,
  type RemapResult,
  validateRemap,
} from "@/actions/bindings";
import {
  chordCanonical,
  chordFromEvent,
  formatBinding,
  isSingleKeyBinding,
  tryParseBinding,
} from "@/actions/keys";
import { useActions } from "@/actions/provider";
import type { ActionGroup, AppAction } from "@/actions/types";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { SkeletonLines } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { loadFailureCopy, previewOnlyMessage } from "./errors.ts";
import { usePreferenceGroup, usePreferencesStatus, useWorkspace } from "./workspace-provider.tsx";

const groupOrder: readonly ActionGroup[] = [
  "navigation",
  "tasks",
  "page",
  "chat",
  "search",
  "general",
];

const groupLabels: Readonly<Record<ActionGroup, string>> = {
  navigation: "Navigation",
  tasks: "Tasks",
  page: "Page",
  chat: "Chat",
  search: "Search",
  general: "General",
};

/** How long a recording waits for a second key before it settles on a single chord. */
const SEQUENCE_WINDOW_MS = 900;

/** Where an action applies, in the plain words the reference uses (keyboard_shortcuts.md). */
function contextNote(action: AppAction): string | null {
  if (action.context === "pane" && action.pane === "inbox") return "While the task list is focused";
  if (action.context === "pane" && action.pane === "page") return "While the task page is focused";
  if (action.context === "pane" && action.pane === "chat") return "While the chat is focused";
  if (action.context === "editor") return "While you are editing the page";
  if (action.context === "composer") return "While you are writing a message";
  return null;
}

/**
 * Settings → Keyboard shortcuts (note 13, keyboard_shortcuts.md): the grouped reference with search,
 * the Disable single-key shortcuts toggle, remapping with conflict and reserved-key detection, and
 * Restore defaults. A remap applies here at once; if it cannot reach the account the row says so
 * instead of pretending it is saved.
 */
export function ShortcutsSettings() {
  const { preferences, ui } = useWorkspace();
  const { actions, platform } = useActions();
  const status = usePreferencesStatus(preferences);
  const snapshot = usePreferenceGroup(preferences, "keyboard");
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [message, setMessage] = useState<{ actionId: string; text: string } | null>(null);
  const searchId = useId();

  const current = useMemo(
    () => parseKeyboardPreferences(snapshot.data, actions, platform),
    [snapshot.data, actions, platform],
  );
  const saved = useMemo(
    () => parseKeyboardPreferences(snapshot.saved, actions, platform),
    [snapshot.saved, actions, platform],
  );

  const save = (next: KeyboardPreferences) => {
    preferences.set("keyboard", next, { immediate: true });
  };

  const applyRemap = (actionId: string, binding: string | null) => {
    const result: RemapResult = validateRemap(actionId, binding, actions, current, platform);
    if (!result.ok) {
      const names =
        result.reason === "conflict"
          ? result.conflictsWith
              .map((id) => actions.find((action) => action.id === id)?.label ?? id)
              .join(", ")
          : "";
      setMessage({
        actionId,
        text: result.reason === "conflict" ? `${result.message}: ${names}` : result.message,
      });
      return;
    }
    setMessage(null);
    save(result.preferences);
  };

  const clearOverride = (actionId: string) => {
    const overrides = { ...current.overrides };
    delete overrides[actionId];
    setMessage(null);
    save({ ...current, overrides });
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return actions.filter((action) => {
      if (!needle) return true;
      const binding = current.overrides[action.id] ?? action.defaultBinding ?? "";
      const parsed = binding ? tryParseBinding(binding) : null;
      const label = parsed ? formatBinding(parsed, platform) : null;
      return [
        action.label,
        ...(action.keywords ?? []),
        binding,
        label?.display ?? "",
        label?.spoken ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [actions, current.overrides, platform, query]);

  const grouped = useMemo(
    () =>
      groupOrder
        .map((group) => ({
          group,
          items: visible.filter((action) => (action.group ?? "general") === group),
        }))
        .filter((entry) => entry.items.length > 0),
    [visible],
  );

  if (status === "loading" || status === "idle") {
    return (
      <div className="sym-settings">
        <h1 className="sym-settings-title">Keyboard shortcuts</h1>
        <SkeletonLines label="Loading your shortcuts" />
      </div>
    );
  }

  if (status === "error" && preferences.failure) {
    return (
      <div className="sym-settings">
        <h1 className="sym-settings-title">Keyboard shortcuts</h1>
        <InlineError
          {...loadFailureCopy(preferences.failure, "your shortcuts")}
          onRetry={() => preferences.load()}
        />
      </div>
    );
  }

  return (
    <div className="sym-settings">
      <div className="sym-settings-head">
        <h1 className="sym-settings-title">Keyboard shortcuts</h1>
        {snapshot.state === "saving" ? (
          <p role="status" className="sym-save-status">
            <Spinner size={11} />
            Saving…
          </p>
        ) : snapshot.state === "previewing" && snapshot.failure ? (
          <p role="status" className="sym-save-status" data-state="failed">
            {previewOnlyMessage(snapshot.failure)}{" "}
            <button
              type="button"
              className="sym-text-button"
              onClick={() => preferences.retry("keyboard")}
            >
              Retry
            </button>
          </p>
        ) : (
          <p role="status" className="sym-save-status">
            Saved to your account
          </p>
        )}
      </div>

      <div className="sym-settings-section">
        <label className="sym-field-label" htmlFor={searchId}>
          Search shortcuts
        </label>
        <input
          id={searchId}
          type="search"
          className="sym-search-input"
          placeholder="Search by action or key…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="sym-toggle">
          <input
            type="checkbox"
            checked={!current.singleKeyShortcuts}
            onChange={(event) => save({ ...current, singleKeyShortcuts: !event.target.checked })}
          />
          <span>Disable single-key shortcuts</span>
        </label>
        <p className="sym-settings-hint">
          Single-key shortcuts are plain letters and sequences such as{" "}
          <kbd className="sym-kbd">g</kbd> then <kbd className="sym-kbd">n</kbd>. They never fire
          while you are typing.
        </p>
      </div>

      {grouped.length === 0 ? (
        <p className="sym-inbox-note">{`No shortcuts match “${query.trim()}”.`}</p>
      ) : null}

      {grouped.map(({ group, items }) => (
        <section key={group} className="sym-settings-section" aria-label={groupLabels[group]}>
          <h2 className="sym-settings-heading">{groupLabels[group]}</h2>
          <ul className="sym-shortcut-list">
            {items.map((action) => (
              <ShortcutRow
                key={action.id}
                action={action}
                preferences={current}
                savedPreferences={saved}
                recording={recording === action.id}
                message={message?.actionId === action.id ? message.text : null}
                onRecord={() => {
                  setMessage(null);
                  setRecording(action.id);
                }}
                onCancel={() => setRecording(null)}
                onBinding={(binding) => {
                  setRecording(null);
                  applyRemap(action.id, binding);
                }}
                onUnbind={() => applyRemap(action.id, null)}
                onReset={() => clearOverride(action.id)}
              />
            ))}
          </ul>
        </section>
      ))}

      <Button
        variant="secondary"
        size="md"
        className="self-start"
        onClick={() =>
          ui.openDialog({
            kind: "restore-defaults",
            title: "Restore the default shortcuts?",
            description:
              "Every shortcut you changed goes back to its default, and single-key shortcuts are switched on again.",
            confirmLabel: "Restore defaults",
            confirm: () => {
              ui.closeDialog();
              save(DEFAULT_KEYBOARD_PREFERENCES);
            },
          })
        }
      >
        Restore defaults
      </Button>
    </div>
  );
}

function ShortcutRow({
  action,
  preferences,
  savedPreferences,
  recording,
  message,
  onRecord,
  onCancel,
  onBinding,
  onUnbind,
  onReset,
}: {
  readonly action: AppAction;
  readonly preferences: KeyboardPreferences;
  readonly savedPreferences: KeyboardPreferences;
  readonly recording: boolean;
  readonly message: string | null;
  readonly onRecord: () => void;
  readonly onCancel: () => void;
  readonly onBinding: (binding: string) => void;
  readonly onUnbind: () => void;
  readonly onReset: () => void;
}) {
  const { platform } = useActions();
  const binding = Object.hasOwn(preferences.overrides, action.id)
    ? preferences.overrides[action.id]
    : action.defaultBinding;
  const savedBinding = Object.hasOwn(savedPreferences.overrides, action.id)
    ? savedPreferences.overrides[action.id]
    : action.defaultBinding;
  const parsed = binding ? tryParseBinding(binding) : null;
  const label = parsed ? formatBinding(parsed, platform) : null;
  const overridden = Object.hasOwn(preferences.overrides, action.id);
  const unsaved = binding !== savedBinding;
  const note = contextNote(action);
  const singleKey = parsed ? isSingleKeyBinding(parsed) : false;

  return (
    <li className="sym-shortcut-row">
      <span className="sym-shortcut-label">
        <span>{action.label}</span>
        {note ? <span className="sym-shortcut-note">{note}</span> : null}
        {singleKey ? <span className="sym-shortcut-note">Unavailable while typing</span> : null}
      </span>
      <span className="sym-shortcut-keys">
        {recording ? (
          <BindingRecorder onBinding={onBinding} onCancel={onCancel} />
        ) : label ? (
          <span className="sym-kbd-group">
            <span aria-hidden="true">{label.display}</span>
            <span className="sr-only">{label.spoken}</span>
          </span>
        ) : (
          <span className="sym-shortcut-note">No shortcut</span>
        )}
        {unsaved && !recording ? (
          <span className="sym-shortcut-note" data-state="unsaved">
            Previewing here
          </span>
        ) : null}
      </span>
      <span className="sym-shortcut-actions">
        {recording ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onRecord}>
              Change
            </Button>
            {binding ? (
              <Button variant="ghost" size="sm" onClick={onUnbind}>
                Remove
              </Button>
            ) : null}
            {overridden ? (
              <Button variant="ghost" size="sm" onClick={onReset}>
                Reset
              </Button>
            ) : null}
          </>
        )}
      </span>
      {message ? (
        <span role="alert" className="sym-shortcut-message">
          {message}
        </span>
      ) : null}
    </li>
  );
}

/**
 * Records one binding. Modifier chords settle immediately; a plain key waits briefly for a second key,
 * so sequences such as `g` then `n` can be recorded. Escape cancels, and nothing here shows raw key
 * codes (note 13).
 */
function BindingRecorder({
  onBinding,
  onCancel,
}: {
  readonly onBinding: (binding: string) => void;
  readonly onCancel: () => void;
}) {
  const { platform } = useActions();
  const [steps, setSteps] = useState<readonly string[]>([]);
  const ref = useRef<HTMLParagraphElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  useEffect(() => {
    ref.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      const chord = chordFromEvent(event, platform);
      if (!chord) return;
      const canonical = chordCanonical(chord);
      const next = [...stepsRef.current, canonical];
      const unmodified = chord.modifiers.every((modifier) => modifier === "shift");
      if (!unmodified || next.length > 1) {
        if (timer.current) clearTimeout(timer.current);
        onBinding(next.join(" "));
        return;
      }
      setSteps(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => onBinding(next.join(" ")), SEQUENCE_WINDOW_MS);
    };
    // Capture phase: the app's own dispatcher never sees the keys being recorded.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [onBinding, onCancel, platform]);

  const preview = steps.length > 0 ? tryParseBinding(steps.join(" ")) : null;
  return (
    <p ref={ref} tabIndex={-1} role="status" className="sym-shortcut-recording">
      {preview ? `${formatBinding(preview, platform).display} …` : "Press the keys you want"}
      <span className="sym-shortcut-note">Escape cancels</span>
    </p>
  );
}
