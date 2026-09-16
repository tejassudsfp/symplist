"use client";

import { useEffect } from "react";

/*
 * Opening a search result moves focus to the task that opened, so a keyboard-only reader carries on
 * where the result took them (note 13: focus returns after every overlay; note 14: navigation opens
 * the correct task). The shell owns the regions, so this only focuses them once the route arrives.
 */

const MAIN_ID = "main";
const INBOX_TITLE_ID = "sym-inbox-title";

let pendingPath: string | null = null;

/** After navigating to `href`, focus the opened task's page (or the list on a phone). */
export function focusAfterNavigation(href: string): void {
  pendingPath = href.split(/[?#]/, 1)[0] ?? href;
}

function isRendered(element: HTMLElement): boolean {
  return typeof element.checkVisibility === "function"
    ? element.checkVisibility()
    : element.getClientRects().length > 0;
}

/** Focuses the primary region: the page, or the task list when the page is not on screen. */
export function focusPrimaryRegion(): boolean {
  const main = document.getElementById(MAIN_ID);
  const inbox = document.getElementById(INBOX_TITLE_ID);
  const target = main && isRendered(main) ? main : inbox && isRendered(inbox) ? inbox : null;
  target?.focus();
  return target !== null;
}

/** Completes a pending focus move once the route the reader opened is showing. */
export function usePostNavigationFocus(pathname: string | null): void {
  useEffect(() => {
    if (pendingPath === null || pathname !== pendingPath) return;
    pendingPath = null;
    const handle = requestAnimationFrame(() => {
      focusPrimaryRegion();
    });
    return () => cancelAnimationFrame(handle);
  }, [pathname]);
}

/** Forgets a pending focus move (a second navigation, or an overlay that closed instead). */
export function cancelPostNavigationFocus(): void {
  pendingPath = null;
}
