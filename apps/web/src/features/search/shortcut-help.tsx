"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { ACTION_LAYER_ATTRIBUTE } from "@/actions/focus";
import type { BindingLabel } from "@/actions/keys";
import { useActions } from "@/actions/provider";
import type { ActionGroup, AppAction } from "@/actions/types";
import { Button } from "@/components/ui/button";
import { Keycaps } from "./keycaps.tsx";
import { type SearchOverlay, searchOverlay } from "./store.ts";

/*
 * The shortcut help overlay (keyboard_shortcuts.md, note 13): opened by `?` or the profile menu,
 * grouped Navigation, Tasks, Page, Chat, Search and General, searchable by action name or binding,
 * with platform key caps and sequences shown differently from chords. It reads the live registry, so
 * a remapped binding shows its new keys here and in every menu. Remapping itself lives in Settings.
 */

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

/** The group a shortcut is listed under: its own, or the one its context implies. */
export function groupOf(action: AppAction): ActionGroup {
  if (action.group) return action.group;
  if (action.context === "editor") return "page";
  if (action.context === "composer") return "chat";
  if (action.context === "pane") {
    if (action.pane === "page") return "page";
    if (action.pane === "chat") return "chat";
    return "tasks";
  }
  return "general";
}

/** Named keys that are not "single-key shortcuts": they never type a character. */
const namedCapLabels = new Set(["↑", "↓", "←", "→", "+", "⇥", "⌫", "⌦", "↩"]);

/**
 * Whether a binding is a sequence or an unmodified printable key, which note 13 keeps out of text
 * fields and the Disable single-key shortcuts toggle turns off.
 */
export function isSingleKeyLabel(binding: BindingLabel): boolean {
  if (binding.steps.length > 1) return true;
  const caps = binding.steps[0] ?? [];
  const only = caps.length === 1 ? caps[0] : undefined;
  return only !== undefined && only.label.length === 1 && !namedCapLabels.has(only.label);
}

/** Where a shortcut applies, and when it is deliberately inactive (keyboard_shortcuts.md). */
export function contextNotes(
  action: AppAction,
  binding: BindingLabel,
  reason: string | undefined,
): readonly string[] {
  const notes: string[] = [];
  if (action.context === "editor") notes.push("In the page editor");
  else if (action.context === "composer") notes.push("In the chat composer");
  else if (action.context === "modal" || action.context === "menu")
    notes.push("In dialogs and menus");
  else if (action.context === "pane") {
    notes.push(
      action.pane === "page"
        ? "While the page is focused"
        : action.pane === "chat"
          ? "While the chat is focused"
          : action.pane === "inbox"
            ? "While the task list is focused"
            : "While a workspace pane is focused",
    );
  }
  if (isSingleKeyLabel(binding)) notes.push("Unavailable while typing");
  if (reason) notes.push(reason);
  return notes;
}

/** Normalizes a typed binding ("cmd k", "Ctrl+K", "g c") so it can be compared with a real one. */
export function bindingSearchKey(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("⌘", "mod")
    .replaceAll("⌃", "ctrl")
    .replaceAll("⌥", "alt")
    .replaceAll("⇧", "shift")
    .replaceAll("command", "mod")
    .replaceAll("cmd", "mod")
    .replaceAll("control", "ctrl")
    .replaceAll("option", "alt")
    .replaceAll(" then ", "")
    .replace(/[\s+]/g, "");
}

function bindingKeys(binding: BindingLabel, platform: "mac" | "other"): readonly string[] {
  const display = bindingSearchKey(binding.display);
  const spoken = bindingSearchKey(binding.spoken.replace(/,/g, " "));
  // On Windows and Linux "ctrl" is what `mod` shows, so a typed "ctrl+k" finds Mod+K there too.
  const modded = platform === "other" ? display.replaceAll("ctrl", "mod") : display;
  return [display, spoken, modded];
}

interface ShortcutEntry {
  readonly action: AppAction;
  readonly binding: BindingLabel;
  readonly notes: readonly string[];
  readonly group: ActionGroup;
}

export interface ShortcutHelpDialogProps {
  readonly overlay: Extract<SearchOverlay, { kind: "help" }>;
}

export function ShortcutHelpDialog({ overlay }: ShortcutHelpDialogProps) {
  const { actions, availability, bindingLabel, platform } = useActions();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const baseId = useId();

  const entries = useMemo<readonly ShortcutEntry[]>(() => {
    return actions.flatMap((action) => {
      const binding = bindingLabel(action.id);
      if (!binding) return [];
      const state = availability(action.id, "keyboard");
      const notes = contextNotes(
        action,
        binding,
        state?.enabled === false ? state.reason : undefined,
      );
      return [{ action, binding, notes, group: groupOf(action) }];
    });
  }, [actions, availability, bindingLabel]);

  const trimmed = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!trimmed) return entries;
    const key = bindingSearchKey(trimmed);
    return entries.filter((entry) => {
      if (entry.action.label.toLowerCase().includes(trimmed)) return true;
      if ((entry.action.keywords ?? []).some((word) => word.toLowerCase().includes(trimmed)))
        return true;
      if (groupLabels[entry.group].toLowerCase().includes(trimmed)) return true;
      return (
        key.length > 0 && bindingKeys(entry.binding, platform).some((value) => value.includes(key))
      );
    });
  }, [entries, trimmed, platform]);

  const groups = groupOrder
    .map((group) => ({
      group,
      entries: filtered.filter((entry) => entry.group === group),
    }))
    .filter((group) => group.entries.length > 0);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) searchOverlay.close();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="sym-dialog-backdrop" />
        <DialogPrimitive.Popup
          data-slot="shortcut-help-dialog"
          data-search-overlay="help"
          {...{ [ACTION_LAYER_ATTRIBUTE]: "modal" }}
          className="fixed top-1/2 left-1/2 z-[61] flex max-h-[78vh] w-[calc(100%-32px)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-sym-lg border border-sym-line bg-sym-surface text-sym-text shadow-[0_20px_60px_rgb(0_0_0/0.2)] max-md:top-0 max-md:left-0 max-md:h-dvh max-md:max-h-none max-md:w-full max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none"
          finalFocus={() => (overlay.returnFocus?.isConnected ? overlay.returnFocus : true)}
        >
          <div className="flex items-center gap-2 border-sym-line border-b px-4 py-3">
            <DialogPrimitive.Title className="m-0 flex-1 font-heading font-semibold text-[16px] tracking-[-0.01em]">
              Keyboard shortcuts
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="sym-icon-button"
              aria-label="Close keyboard shortcuts"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6 6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </DialogPrimitive.Close>
          </div>
          <div className="px-4 pt-3">
            <label className="sr-only" htmlFor={`${baseId}-search`}>
              Search shortcuts by action or keys
            </label>
            <input
              id={`${baseId}-search`}
              type="search"
              className="h-8 w-full rounded-sym border border-sym-line-strong bg-sym-surface px-2.5 outline-none focus-visible:border-sym-accent"
              placeholder="Search by action or keys"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {/* The list scrolls and holds no controls of its own, so WCAG 2.1.1 needs it focusable. */}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard-scrollable region. */}
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3" tabIndex={0}>
            {groups.length === 0 ? (
              <p className="py-4 text-[13.5px] text-sym-muted">{`No shortcuts match “${query.trim()}”.`}</p>
            ) : null}
            {groups.map(({ group, entries: groupEntries }) => (
              <section
                key={group}
                aria-labelledby={`${baseId}-${group}`}
                className="mb-4 last:mb-0"
              >
                <h3
                  id={`${baseId}-${group}`}
                  className="m-0 mb-1 font-medium text-[11.5px] text-sym-muted uppercase tracking-[0.03em]"
                >
                  {groupLabels[group]}
                </h3>
                <ul className="m-0 flex list-none flex-col p-0">
                  {groupEntries.map((entry) => (
                    <li
                      key={entry.action.id}
                      data-slot="shortcut-row"
                      className="flex items-start justify-between gap-4 border-sym-line border-b py-2 last:border-b-0"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-[13.5px]">{entry.action.label}</span>
                        {entry.notes.length > 0 ? (
                          <span className="text-[12px] text-sym-muted">
                            {entry.notes.join(" · ")}
                          </span>
                        ) : null}
                      </span>
                      <Keycaps label={entry.binding} className="mt-0.5" />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-sym-line border-t px-4 py-3 text-[12.5px] text-sym-muted">
            <span>Every other action is in the command palette. Escape closes this.</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                searchOverlay.close();
                router.push("/settings/shortcuts");
              }}
            >
              Change shortcuts
            </Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
