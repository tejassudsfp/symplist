import { PANE_ATTRIBUTE } from "@/actions/focus";
import type { PaneId } from "@/actions/types";

/*
 * Find within the current surface (note 14 entry point 3, note 13's `/`): the task list filters its
 * collection, the page finds within the opened revision and chat finds within the conversation. Each
 * surface marks its find field with `data-surface-find`, so `/` focuses whichever one is showing
 * without search knowing anything about the other features.
 */

/** `data-surface-find="inbox" | "page" | "chat" | "search"` marks a surface's find field. */
export const SURFACE_FIND_ATTRIBUTE = "data-surface-find";

function isVisible(element: HTMLElement): boolean {
  if (typeof element.checkVisibility === "function") return element.checkVisibility();
  return element.getClientRects().length > 0 || element.offsetParent !== null;
}

/**
 * The find field `/` should focus: the one inside the focused pane when there is one, otherwise the
 * first visible field on the page (the full search screen, or a surface shown on its own).
 */
export function surfaceFindTarget(
  pane: PaneId | null,
  doc: Document | undefined = typeof document === "undefined" ? undefined : document,
): HTMLElement | null {
  if (!doc) return null;
  const fields = [...doc.querySelectorAll<HTMLElement>(`[${SURFACE_FIND_ATTRIBUTE}]`)].filter(
    isVisible,
  );
  if (fields.length === 0) return null;
  if (pane) {
    const inPane = fields.find(
      (field) => field.closest(`[${PANE_ATTRIBUTE}]`)?.getAttribute(PANE_ATTRIBUTE) === pane,
    );
    if (inPane) return inPane;
  }
  return fields[0] ?? null;
}

/** Focuses and selects the surface's find field; returns false when the surface has none. */
export function focusSurfaceFind(pane: PaneId | null): boolean {
  const target = surfaceFindTarget(pane);
  if (!target) return false;
  target.focus();
  if (target instanceof HTMLInputElement) target.select();
  return true;
}
