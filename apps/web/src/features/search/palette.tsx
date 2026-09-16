"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type {
  SearchHighlight,
  SearchIndexStatus,
  SearchTitleMatchKind,
  SearchTitleResponse,
} from "@symplist/contracts";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ACTION_LAYER_ATTRIBUTE } from "@/actions/focus";
import type { BindingLabel } from "@/actions/keys";
import { useActions } from "@/actions/provider";
import type { ActionAvailability, ActionGroup, AppAction } from "@/actions/types";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/features/access/session";
import { FULL_SEARCH_ACTION_ID, OPEN_PALETTE_ACTION_ID } from "./actions.ts";
import { type SearchFailure, type TaskLocation, taskHref } from "./api.ts";
import { useSearchApi } from "./client.tsx";
import { collectionLabels, defaultSearchFilters } from "./filters.ts";
import { HighlightedText } from "./highlight.tsx";
import { Keycaps } from "./keycaps.tsx";
import { failureMessage } from "./messages.ts";
import { focusAfterNavigation } from "./navigation.ts";
import {
  type PaletteMode,
  rememberSearchScreen,
  type SearchOverlay,
  searchOverlay,
} from "./store.ts";
import { reportSearchUsed, resultCountBucket } from "./telemetry.ts";
import { useAsyncSearch, useDebouncedValue } from "./use-async-search.ts";

/*
 * The quick switcher and command palette (command_palette.md, note 13). One compact overlay: the
 * default mode finds tasks by title, `>` or the Actions choice searches the action registry, and
 * "Search all content" hands the query to the full search screen. Nothing is stored: the query lives
 * only while the overlay is open.
 */

/** How long typing settles before a title search runs (note 14: debounce briefly). */
export const PALETTE_DEBOUNCE_MS = 140;
/** Quick title results shown at once. */
export const PALETTE_TITLE_LIMIT = 8;

const matchNotes: Readonly<Record<SearchTitleMatchKind, string | null>> = {
  title_exact: null,
  title_prefix: null,
  title_terms: null,
  title_typo: "Similar spelling",
};

const groupLabels: Readonly<Record<ActionGroup, string>> = {
  navigation: "Navigation",
  tasks: "Tasks",
  page: "Page",
  chat: "Chat",
  search: "Search",
  general: "General",
};

/** A task as the palette shows it, whether it came from recent tasks or from a title search. */
interface PaletteTask {
  readonly id: string;
  readonly title: string;
  readonly highlights: readonly SearchHighlight[];
  readonly collection: "now" | "later" | "unclassified";
  readonly archived: boolean;
  readonly parentTitle: string | null;
  readonly match: SearchTitleMatchKind | null;
}

type PaletteItem =
  | { readonly kind: "task"; readonly key: string; readonly task: PaletteTask }
  | {
      readonly kind: "action";
      readonly key: string;
      readonly action: AppAction;
      readonly availability: ActionAvailability;
      readonly binding: BindingLabel | null;
    }
  | { readonly kind: "full_search"; readonly key: string; readonly query: string };

interface ItemGroup {
  readonly label: string | null;
  readonly items: readonly PaletteItem[];
}

function taskFromRecent(task: TaskLocation): PaletteTask {
  return {
    id: task.id,
    title: task.title,
    highlights: [],
    collection: task.collection,
    archived: task.archived,
    parentTitle: task.parentTitle,
    match: null,
  };
}

function tasksFromResponse(response: SearchTitleResponse): readonly PaletteTask[] {
  return response.items.map((item) => ({
    id: item.task.id,
    title: item.task.title,
    highlights: item.task.titleHighlights,
    collection: item.task.collection,
    archived: item.task.archived,
    parentTitle: item.task.parent?.title ?? null,
    match: item.match,
  }));
}

/** Simple, deterministic scoring for the action list: a prefix beats a word start beats a contains. */
export function scoreAction(action: AppAction, query: string, groupLabel: string): number {
  const haystacks = [action.label, groupLabel, ...(action.keywords ?? [])];
  let best = 0;
  for (const [index, text] of haystacks.entries()) {
    const value = text.toLowerCase();
    const weight = index === 0 ? 1 : 0.6;
    if (value.startsWith(query)) best = Math.max(best, 3 * weight);
    else if (value.includes(` ${query}`)) best = Math.max(best, 2 * weight);
    else if (value.includes(query)) best = Math.max(best, 1 * weight);
  }
  return best;
}

interface PaletteContent {
  readonly groups: readonly ItemGroup[];
  readonly items: readonly PaletteItem[];
}

function flatten(groups: readonly ItemGroup[]): PaletteContent {
  return { groups, items: groups.flatMap((group) => group.items) };
}

/** Everything the palette can show for the current mode and query. */
function buildContent(options: {
  readonly mode: PaletteMode;
  readonly query: string;
  readonly tasks: readonly PaletteTask[];
  readonly recent: boolean;
  readonly actions: readonly AppAction[];
  readonly availability: (id: string) => ActionAvailability | null;
  readonly bindingLabel: (id: string) => BindingLabel | null;
}): PaletteContent {
  if (options.mode === "actions") {
    const query = options.query.trim().toLowerCase();
    const scored = options.actions
      .filter((action) => action.id !== OPEN_PALETTE_ACTION_ID)
      .map((action) => {
        const group = action.group ?? "general";
        return { action, group, score: query ? scoreAction(action, query, groupLabels[group]) : 1 };
      })
      .filter((entry) => entry.score > 0);
    const toItem = (action: AppAction): PaletteItem => ({
      kind: "action",
      key: `action:${action.id}`,
      action,
      availability: options.availability(action.id) ?? { enabled: true },
      binding: options.bindingLabel(action.id),
    });
    if (query) {
      const items = scored
        .sort(
          (left, right) =>
            right.score - left.score || left.action.label.localeCompare(right.action.label),
        )
        .map((entry) => toItem(entry.action));
      return flatten(items.length > 0 ? [{ label: "Actions", items }] : []);
    }
    const order: readonly ActionGroup[] = [
      "navigation",
      "tasks",
      "page",
      "chat",
      "search",
      "general",
    ];
    const groups = order
      .map((group) => ({
        label: groupLabels[group],
        items: scored.filter((entry) => entry.group === group).map((entry) => toItem(entry.action)),
      }))
      .filter((group) => group.items.length > 0);
    return flatten(groups);
  }
  const taskItems: readonly PaletteItem[] = options.tasks.map((task) => ({
    kind: "task",
    key: `task:${task.id}`,
    task,
  }));
  const groups: ItemGroup[] = [];
  if (taskItems.length > 0) {
    groups.push({ label: options.recent ? "Recent tasks" : "Tasks", items: taskItems });
  }
  groups.push({
    label: null,
    items: [{ kind: "full_search", key: "full-search", query: options.query.trim() }],
  });
  return flatten(groups);
}

const freshnessNotes: Readonly<Record<SearchIndexStatus, string | null>> = {
  ready: null,
  partial: "Some very recent changes may not be searchable yet.",
  rebuilding: "Search is rebuilding its index; task titles are still searched.",
};

export interface PaletteDialogProps {
  readonly overlay: Extract<SearchOverlay, { kind: "palette" }>;
}

export function PaletteDialog({ overlay }: PaletteDialogProps) {
  const router = useRouter();
  const api = useSearchApi();
  const session = useSession();
  const { actions, availability, bindingLabel, invoke } = useActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const intentRef = useRef<null | { readonly run: () => void }>(null);
  const [mode, setMode] = useState<PaletteMode>(overlay.mode);
  const [query, setQuery] = useState(overlay.query);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;

  const access = session.access;
  const admitted =
    session.status === "signed_in" && access
      ? access.emailVerifiedAt !== null &&
        access.suspendedAt === null &&
        access.betaState === "unlocked" &&
        access.deletionState === "none"
      : session.status !== "signed_out";
  const signedOut = session.status === "signed_out";

  const trimmed = query.trim();
  const debounced = useDebouncedValue(trimmed, PALETTE_DEBOUNCE_MS, (value) => value.length === 0);
  const searching = mode === "tasks" && debounced.length > 0 && admitted;
  const showRecent = mode === "tasks" && trimmed.length === 0 && admitted;

  const titles = useAsyncSearch<SearchTitleResponse>({
    key: `titles:${debounced}`,
    enabled: searching,
    run: (signal) => api.titles(debounced, { limit: PALETTE_TITLE_LIMIT }, signal),
  });
  const recent = useAsyncSearch<readonly TaskLocation[]>({
    key: "recent",
    enabled: showRecent,
    run: (signal) => api.recentTasks(signal),
    keepPrevious: false,
  });

  const tasks = useMemo<readonly PaletteTask[]>(() => {
    if (mode !== "tasks") return [];
    if (trimmed.length === 0) return (recent.data ?? []).map(taskFromRecent);
    return titles.data ? tasksFromResponse(titles.data) : [];
  }, [mode, trimmed, recent.data, titles.data]);

  // One report per settled title search, with counts only (decision C5.3).
  useEffect(() => {
    if (!titles.data) return;
    reportSearchUsed({
      surface: "command_palette",
      include_archive: false,
      include_chat: false,
      result_count: resultCountBucket(titles.data.items.length),
    });
  }, [titles.data]);

  const content = useMemo(
    () =>
      buildContent({
        mode,
        query,
        tasks,
        recent: trimmed.length === 0,
        actions,
        availability: (id) => availability(id, "palette", overlay.pane),
        bindingLabel,
      }),
    [mode, query, trimmed, tasks, actions, availability, bindingLabel, overlay.pane],
  );

  const items = content.items;
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.key === activeKey),
  );
  const active = items[activeIndex] ?? items[0] ?? null;
  const activeId = active ? `${baseId}-${active.key}` : undefined;

  useEffect(() => {
    if (!active) return;
    const element = listRef.current?.querySelector<HTMLElement>(
      `[data-item-key="${CSS.escape(active.key)}"]`,
    );
    // jsdom and older browsers have no scrollIntoView; keeping the active row in view is optional.
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  const close = useCallback(() => {
    searchOverlay.close();
  }, []);

  /** Closes the palette, then runs what the reader chose once focus has left the overlay. */
  const commit = useCallback((run: () => void) => {
    intentRef.current = { run };
    searchOverlay.close();
    requestAnimationFrame(() => {
      const intent = intentRef.current;
      intentRef.current = null;
      intent?.run();
    });
  }, []);

  const openTask = useCallback(
    (task: PaletteTask) => {
      const href = taskHref(task);
      commit(() => {
        // Opening a task switches its page and chat together (command_palette.md); focus follows.
        focusAfterNavigation(href);
        router.push(href);
      });
    },
    [commit, router],
  );

  const runAction = useCallback(
    (item: Extract<PaletteItem, { kind: "action" }>) => {
      if (!item.availability.enabled) return;
      commit(() => {
        void invoke(item.action.id, "palette", overlay.pane);
      });
    },
    [commit, invoke, overlay.pane],
  );

  const openFullSearch = useCallback(
    (text: string) => {
      rememberSearchScreen({
        query: text,
        filters: defaultSearchFilters,
        returnHref: typeof window === "undefined" ? null : window.location.pathname,
        activeKey: null,
      });
      commit(() => {
        void invoke(FULL_SEARCH_ACTION_ID, "palette", overlay.pane);
      });
    },
    [commit, invoke, overlay.pane],
  );

  const execute = useCallback(
    (item: PaletteItem) => {
      if (item.kind === "task") openTask(item.task);
      else if (item.kind === "action") runAction(item);
      else openFullSearch(item.query);
    },
    [openTask, runAction, openFullSearch],
  );

  const move = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      const next = Math.min(items.length - 1, Math.max(0, activeIndex + delta));
      setActiveKey(items[next]?.key ?? null);
    },
    [items, activeIndex],
  );

  const onQueryChange = useCallback((value: string) => {
    // `>` at the start switches to actions, as command_palette.md asks.
    if (value.startsWith(">")) {
      setMode("actions");
      setQuery(value.slice(1).trimStart());
    } else {
      setQuery(value);
    }
    setActiveKey(null);
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        close();
        return;
      }
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          move(1);
          return;
        case "ArrowUp":
          event.preventDefault();
          move(-1);
          return;
        case "Home":
          if (items[0]) {
            event.preventDefault();
            setActiveKey(items[0].key);
          }
          return;
        case "End":
          if (items.at(-1)) {
            event.preventDefault();
            setActiveKey(items.at(-1)?.key ?? null);
          }
          return;
        case "Enter": {
          if (!active) return;
          event.preventDefault();
          execute(active);
          return;
        }
        case "Backspace":
          if (mode === "actions" && query.length === 0) {
            event.preventDefault();
            setMode("tasks");
          }
          return;
        default:
      }
    },
    [active, close, execute, items, mode, move, query.length],
  );

  const switchMode = useCallback((next: PaletteMode) => {
    setMode(next);
    setQuery("");
    setActiveKey(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const failure: SearchFailure | null = signedOut
    ? { kind: "signed_out" }
    : !admitted
      ? { kind: "no_access" }
      : searching
        ? titles.failure
        : showRecent
          ? recent.failure
          : null;
  const loading =
    (searching && titles.status === "loading") || (showRecent && recent.status === "loading");
  const freshness = mode === "tasks" && titles.data ? titles.data : null;
  const note = freshness ? freshnessNotes[freshness.status] : null;

  const summary = failure
    ? failureMessage(failure).title
    : loading
      ? "Searching…"
      : mode === "actions"
        ? `${items.filter((item) => item.kind === "action").length} actions`
        : trimmed.length === 0
          ? `${tasks.length} recent tasks`
          : `${tasks.length} tasks match`;

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="sym-dialog-backdrop" />
        <DialogPrimitive.Popup
          data-slot="command-palette-dialog"
          data-search-overlay="palette"
          {...{ [ACTION_LAYER_ATTRIBUTE]: "modal" }}
          className="fixed top-[10vh] left-1/2 z-[61] flex max-h-[70vh] w-[calc(100%-32px)] max-w-[640px] -translate-x-1/2 flex-col overflow-hidden rounded-sym-lg border border-sym-line bg-sym-surface text-sym-text shadow-[0_20px_60px_rgb(0_0_0/0.2)] max-md:top-0 max-md:left-0 max-md:h-dvh max-md:max-h-none max-md:w-full max-md:translate-x-0 max-md:rounded-none"
          initialFocus={inputRef}
          finalFocus={() => {
            if (intentRef.current) return false;
            return overlay.returnFocus?.isConnected ? overlay.returnFocus : true;
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            Search tasks and actions
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Type to find a task by title. Start with a greater-than sign, or choose Actions, to run
            a command.
          </DialogPrimitive.Description>
          <div className="flex items-center gap-2 border-sym-line border-b px-3 py-2.5">
            <DialogPrimitive.Close
              className="sym-icon-button sym-mobile-only -ml-1 size-8"
              aria-label="Close search"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="m15 18-6-6 6-6"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </DialogPrimitive.Close>
            <span aria-hidden="true" className="flex text-sym-faint">
              {mode === "actions" ? (
                <span className="font-mono text-[15px] leading-none">&gt;</span>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                  <path
                    d="m20 20-3.5-3.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </span>
            <label className="sr-only" htmlFor={`${baseId}-input`}>
              {mode === "actions" ? "Search actions" : "Search tasks"}
            </label>
            <input
              id={`${baseId}-input`}
              ref={inputRef}
              className="min-w-0 flex-1 border-0 bg-transparent text-[15px] outline-none"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              {...(activeId ? { "aria-activedescendant": activeId } : {})}
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              placeholder={mode === "actions" ? "Search actions…" : "Search tasks…"}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={onKeyDown}
            />
            {loading ? <Spinner label="Searching" /> : null}
            {/* biome-ignore lint/a11y/useSemanticElements: two toggle buttons, not a form fieldset. */}
            <div
              role="group"
              aria-label="Search mode"
              className="flex flex-none gap-1 rounded-sym bg-sym-hover p-[3px]"
            >
              {(["tasks", "actions"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  className="h-6 rounded-[4px] px-2 font-medium text-[12px] text-sym-muted aria-pressed:bg-sym-surface aria-pressed:text-sym-text aria-pressed:shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                  onClick={() => switchMode(value)}
                >
                  {value === "tasks" ? "Tasks" : "Actions"}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-1.5" ref={listRef}>
            {failure ? (
              <PaletteFailure
                failure={failure}
                onRetry={
                  failure.kind === "unavailable" || failure.kind === "offline"
                    ? () => (searching ? titles.refresh() : recent.refresh())
                    : undefined
                }
              />
            ) : null}
            {!failure && loading && tasks.length === 0 && mode === "tasks" ? (
              <PaletteSkeleton />
            ) : null}
            {!failure &&
            !loading &&
            mode === "tasks" &&
            trimmed.length > 0 &&
            tasks.length === 0 ? (
              <p className="px-3 py-4 text-[13.5px] text-sym-muted">
                {`No task titles match “${trimmed}”.`}
              </p>
            ) : null}
            {!failure &&
            !loading &&
            mode === "tasks" &&
            trimmed.length === 0 &&
            tasks.length === 0 ? (
              <p className="px-3 py-4 text-[13.5px] text-sym-muted">
                No recent tasks yet. Type to find a task by title.
              </p>
            ) : null}
            {!failure && mode === "actions" && items.length === 0 ? (
              <p className="px-3 py-4 text-[13.5px] text-sym-muted">
                {`No actions match “${trimmed}”.`}
              </p>
            ) : null}
            <div role="listbox" id={listId} aria-label={mode === "actions" ? "Actions" : "Tasks"}>
              {content.groups.map((group) => (
                <PaletteGroup
                  key={group.label ?? "default"}
                  label={group.label}
                  baseId={baseId}
                  items={group.items}
                  activeKey={active?.key ?? null}
                  onActivate={setActiveKey}
                  onExecute={execute}
                />
              ))}
            </div>
          </div>

          <p className="sr-only" role="status" aria-live="polite">
            {summary}
          </p>
          {note ? (
            <p className="m-0 border-sym-line border-t px-3 py-2 text-[12px] text-sym-muted">
              {note}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3 border-sym-line border-t px-3 py-2 text-[12px] text-sym-muted max-md:hidden">
            <span>↑↓ to move · ↵ to open · Esc to close</span>
            <span>
              {mode === "actions" ? "Backspace to search tasks" : "Type > to search actions"}
            </span>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function PaletteGroup({
  label,
  items,
  activeKey,
  baseId,
  onActivate,
  onExecute,
}: {
  readonly label: string | null;
  readonly items: readonly PaletteItem[];
  readonly activeKey: string | null;
  readonly baseId: string;
  readonly onActivate: (key: string) => void;
  readonly onExecute: (item: PaletteItem) => void;
}): ReactNode {
  const labelId = `${baseId}-group-${label ?? "default"}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: an ARIA group inside a listbox, not a fieldset.
    <div role="group" {...(label ? { "aria-labelledby": labelId } : {})}>
      {label ? (
        <p
          id={labelId}
          className="px-[9px] pt-2 pb-1 font-medium text-[11.5px] text-sym-muted uppercase tracking-[0.03em]"
        >
          {label}
        </p>
      ) : null}
      {items.map((item) => (
        <PaletteOption
          key={item.key}
          id={`${baseId}-${item.key}`}
          item={item}
          active={item.key === activeKey}
          onActivate={onActivate}
          onExecute={onExecute}
        />
      ))}
    </div>
  );
}

function PaletteOption({
  id,
  item,
  active,
  onActivate,
  onExecute,
}: {
  readonly id: string;
  readonly item: PaletteItem;
  readonly active: boolean;
  readonly onActivate: (key: string) => void;
  readonly onExecute: (item: PaletteItem) => void;
}): ReactNode {
  const disabled = item.kind === "action" && !item.availability.enabled;
  return (
    // The combobox input keeps focus and drives selection with aria-activedescendant, so an option is
    // never focused itself and every key press is handled by the input's own handler.
    // A listbox option, not a <select> option: the combobox input keeps focus, drives selection with
    // aria-activedescendant and handles Enter, so the option itself is never focused.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above.
    <div
      id={id}
      role="option"
      tabIndex={-1}
      data-item-key={item.key}
      aria-selected={active}
      aria-disabled={disabled || undefined}
      className="flex cursor-default items-center gap-3 rounded-sym px-[9px] py-2 aria-selected:bg-sym-code-bg"
      onMouseMove={() => onActivate(item.key)}
      onClick={() => onExecute(item)}
    >
      {item.kind === "task" ? <PaletteTaskBody task={item.task} /> : null}
      {item.kind === "action" ? <PaletteActionBody item={item} /> : null}
      {item.kind === "full_search" ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[13.5px]">
          <span aria-hidden="true" className="flex text-sym-faint">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path
                d="m20 20-3.5-3.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="truncate">
            {item.query ? `Search all content for “${item.query}”` : "Search all content"}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function PaletteTaskBody({ task }: { readonly task: PaletteTask }): ReactNode {
  const note = task.match ? matchNotes[task.match] : null;
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-[13.5px]">
        <HighlightedText text={task.title} highlights={task.highlights} />
      </span>
      <span className="flex items-center gap-1.5 truncate text-[12px] text-sym-muted">
        <span>{collectionLabels[task.collection]}</span>
        {task.parentTitle ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate">{`in “${task.parentTitle}”`}</span>
          </>
        ) : null}
        {task.archived ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="rounded-full border border-sym-line px-1.5">Archived</span>
          </>
        ) : null}
        {note ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{note}</span>
          </>
        ) : null}
      </span>
    </span>
  );
}

function PaletteActionBody({
  item,
}: {
  readonly item: Extract<PaletteItem, { kind: "action" }>;
}): ReactNode {
  const group = item.action.group ?? "general";
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13.5px]">{item.action.label}</span>
        <span className="truncate text-[12px] text-sym-muted">
          {item.availability.enabled
            ? groupLabels[group]
            : (item.availability.reason ?? `${groupLabels[group]} · unavailable now`)}
        </span>
      </span>
      {item.binding ? <Keycaps label={item.binding} /> : null}
    </>
  );
}

function PaletteSkeleton(): ReactNode {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3.5 px-3 py-3">
      <span className="sr-only">Loading results</span>
      {["62%", "78%", "48%"].map((width, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static decorative bars never reorder.
          key={index}
          aria-hidden="true"
          className="sym-skeleton h-[13px]"
          style={{ width, animationDelay: `${index * 0.15}s` }}
        />
      ))}
    </div>
  );
}

function PaletteFailure({
  failure,
  onRetry,
}: {
  readonly failure: SearchFailure;
  readonly onRetry?: () => void;
}): ReactNode {
  const message = failureMessage(failure);
  return (
    <div role="alert" className="px-3 py-3">
      <p className="font-medium text-[13.5px]">{message.title}</p>
      <p className="mt-0.5 text-[13px] text-sym-muted">{message.description}</p>
      {onRetry ? (
        <button type="button" className="sym-text-button mt-2 text-[13px]" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
