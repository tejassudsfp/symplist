import { type SearchFreshnessEvent, searchFreshnessEventSchema } from "@symplist/contracts";
import { useSyncExternalStore } from "react";
import { PANE_ATTRIBUTE } from "@/actions/focus";
import type { PaneId } from "@/actions/types";
import type { SearchFilters } from "./filters.ts";

/*
 * In-memory state shared by the search surfaces. Nothing here is written to storage: queries live
 * only in page memory, so leaving the app, reloading or signing out forgets them (note 14: no raw
 * query history by default).
 */

type Listener = () => void;

class Store<Value> {
  private listeners = new Set<Listener>();
  constructor(private value: Value) {}

  get = (): Value => this.value;

  set(value: Value): void {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

/* ------------------------------------------------------------------------------------------------
 * Palette and shortcut help overlays
 * --------------------------------------------------------------------------------------------- */

export type PaletteMode = "tasks" | "actions";

export type SearchOverlay =
  | { readonly kind: "closed" }
  | {
      readonly kind: "palette";
      readonly mode: PaletteMode;
      readonly query: string;
      /** Where focus returns when the palette closes without navigating. */
      readonly returnFocus: HTMLElement | null;
      /** The workspace pane that held focus before opening, for pane actions run from the palette. */
      readonly pane: PaneId | null;
      readonly openCount: number;
    }
  | {
      readonly kind: "help";
      readonly returnFocus: HTMLElement | null;
      readonly openCount: number;
    };

const overlayStore = new Store<SearchOverlay>({ kind: "closed" });
let openCount = 0;

function isPane(value: string | null | undefined): value is PaneId {
  return value === "inbox" || value === "page" || value === "chat";
}

/**
 * The element focus should return to. Inside an open menu (the profile menu's Keyboard shortcuts
 * item) the menu is about to close and hand focus back to its trigger, so the trigger is used.
 */
export function captureReturnFocus(doc: Document = document): {
  element: HTMLElement | null;
  pane: PaneId | null;
} {
  const active = doc.activeElement;
  if (!(active instanceof HTMLElement) || active === doc.body) return { element: null, pane: null };
  if (active.closest("[data-search-overlay]")) {
    const current = overlayStore.get();
    return current.kind === "closed"
      ? { element: null, pane: null }
      : { element: current.returnFocus, pane: current.kind === "palette" ? current.pane : null };
  }
  const paneValue = active.closest(`[${PANE_ATTRIBUTE}]`)?.getAttribute(PANE_ATTRIBUTE);
  const pane = isPane(paneValue) ? paneValue : null;
  if (active.closest('[role="menu"]')) {
    const trigger = doc.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]');
    return { element: trigger, pane };
  }
  return { element: active, pane };
}

export const searchOverlay = {
  get: overlayStore.get,
  subscribe: overlayStore.subscribe,
  openPalette(options: { readonly mode?: PaletteMode; readonly query?: string } = {}): void {
    const { element, pane } = captureReturnFocus();
    openCount += 1;
    overlayStore.set({
      kind: "palette",
      mode: options.mode ?? "tasks",
      query: options.query ?? "",
      returnFocus: element,
      pane,
      openCount,
    });
  },
  openHelp(): void {
    const { element } = captureReturnFocus();
    openCount += 1;
    overlayStore.set({ kind: "help", returnFocus: element, openCount });
  },
  close(): void {
    overlayStore.set({ kind: "closed" });
  },
};

export function useSearchOverlay(): SearchOverlay {
  return useSyncExternalStore(overlayStore.subscribe, overlayStore.get, overlayStore.get);
}

/* ------------------------------------------------------------------------------------------------
 * Index freshness signals
 * --------------------------------------------------------------------------------------------- */

export interface FreshnessSignal extends SearchFreshnessEvent {
  readonly receivedAt: number;
}

const freshnessStore = new Store<FreshnessSignal | null>(null);

/**
 * The latest known index generation and pending change count. Search polls `GET /v1/search/freshness`
 * while results are behind, and the owner of the app's realtime socket forwards `search.freshness`
 * events here (§7), so every open search surface can offer a refresh instead of replacing results.
 */
export const searchFreshness = {
  get: freshnessStore.get,
  subscribe: freshnessStore.subscribe,
  /** Accepts a `search.freshness` event payload; anything that fails the contract is ignored. */
  publish(event: unknown, now: number = Date.now()): boolean {
    const parsed = searchFreshnessEventSchema.safeParse(event);
    if (!parsed.success) return false;
    const current = freshnessStore.get();
    // Generations only move forward; an older announcement never hides a newer one.
    if (current && parsed.data.generation < current.generation) return false;
    freshnessStore.set({ ...parsed.data, receivedAt: now });
    return true;
  },
  reset(): void {
    freshnessStore.set(null);
  },
};

export function useSearchFreshnessSignal(): FreshnessSignal | null {
  return useSyncExternalStore(freshnessStore.subscribe, freshnessStore.get, () => null);
}

/* ------------------------------------------------------------------------------------------------
 * Full search screen memory
 * --------------------------------------------------------------------------------------------- */

export interface SearchScreenMemory {
  readonly query: string;
  readonly filters: SearchFilters;
  /** Where Escape on an empty query and the Back control return to; null when unknown. */
  readonly returnHref: string | null;
  /** The result that was opened, so returning from the task restores the selection. */
  readonly activeKey: string | null;
}

let screenMemory: SearchScreenMemory | null = null;

/** Keeps the full search query and filters while the user visits a task (search.md). */
export function rememberSearchScreen(memory: SearchScreenMemory): void {
  screenMemory = memory;
}

export function recallSearchScreen(): SearchScreenMemory | null {
  return screenMemory;
}

export function forgetSearchScreen(): void {
  screenMemory = null;
}

/* ------------------------------------------------------------------------------------------------
 * Jumps from a result into a task
 * --------------------------------------------------------------------------------------------- */

/**
 * What a task page needs to open a search hit accurately (note 14): the section or message, the
 * revision it was indexed from, and whether the head has moved since. Opaque ids also travel in the
 * task URL (`SEARCH_JUMP_PARAMS`); the heading and query stay in memory only.
 */
export interface SearchJump {
  readonly taskId: string;
  readonly query: string;
  readonly section?: {
    readonly sectionId: string;
    readonly ordinal: number;
    readonly heading: string | null;
    readonly indexedRevision: string;
    readonly currentRevision: string | null;
    readonly stale: boolean;
  };
  readonly message?: { readonly messageId: string; readonly conversationId: string };
}

/** A jump older than this is ignored, so a later visit never scrolls to an old result. */
export const SEARCH_JUMP_TTL_MS = 60_000;

let pendingJump: { readonly jump: SearchJump; readonly at: number } | null = null;

export function setSearchJump(jump: SearchJump, now: number = Date.now()): void {
  pendingJump = { jump, at: now };
}

/** The pending jump for a task without consuming it. */
export function peekSearchJump(taskId: string, now: number = Date.now()): SearchJump | null {
  if (!pendingJump || pendingJump.jump.taskId !== taskId) return null;
  if (now - pendingJump.at > SEARCH_JUMP_TTL_MS) {
    pendingJump = null;
    return null;
  }
  return pendingJump.jump;
}

/** Takes the pending jump for a task once; the documents and chat panes call this when they open. */
export function consumeSearchJump(taskId: string, now: number = Date.now()): SearchJump | null {
  const jump = peekSearchJump(taskId, now);
  if (jump) pendingJump = null;
  return jump;
}
