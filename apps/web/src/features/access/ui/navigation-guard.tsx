"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { navigateAcrossGroups } from "../navigation.ts";

export interface NavigationGuardCopy {
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

export interface NavigationGuard {
  /** The confirmation dialog; render it once in the guarded screen. */
  readonly dialog: ReactNode;
  /** Navigates now when nothing is at stake, otherwise asks first. */
  requestNavigation(href: string): void;
}

function isPlainLeftClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Asks before leaving a screen with something at stake (unsaved name edits, unacknowledged one-time
 * codes): link clicks anywhere in the document are held for a decision, and closing or reloading the
 * tab raises the browser's own prompt. Leaving is always possible; the dialog only makes it explicit
 * (settings_account.md, admin_invite_create.md).
 */
export function useNavigationGuard(active: boolean, copy: NavigationGuardCopy): NavigationGuard {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const activeRef = useRef(active);
  const bypassRef = useRef(false);

  useEffect(() => {
    activeRef.current = active;
    if (!active) setPendingHref(null);
  }, [active]);

  const go = useCallback(
    (href: string) => {
      bypassRef.current = true;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) {
        window.location.assign(url.href);
        return;
      }
      navigateAcrossGroups(router, `${url.pathname}${url.search}${url.hash}`);
      // Client navigations keep this component mounted until the route changes.
      queueMicrotask(() => {
        bypassRef.current = false;
      });
    },
    [router],
  );

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!activeRef.current || bypassRef.current) return;
      event.preventDefault();
      // Older browsers need a return value to show their prompt.
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      if (!activeRef.current || bypassRef.current || event.defaultPrevented) return;
      if (!isPlainLeftClick(event)) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      if (target.target && target.target !== "_self") return;
      if (target.hasAttribute("download")) return;
      const url = new URL(target.href, window.location.href);
      const here = new URL(window.location.href);
      if (
        url.origin === here.origin &&
        url.pathname === here.pathname &&
        url.search === here.search
      ) {
        return;
      }
      event.preventDefault();
      setPendingHref(
        url.origin === here.origin ? `${url.pathname}${url.search}${url.hash}` : url.href,
      );
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  const requestNavigation = useCallback(
    (href: string) => {
      if (activeRef.current) setPendingHref(href);
      else go(href);
    },
    [go],
  );

  const dialog = (
    <ConfirmDialog
      open={pendingHref !== null}
      onOpenChange={(open) => {
        if (!open) setPendingHref(null);
      }}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      cancelLabel={copy.cancelLabel}
      initialFocus="cancel"
      onConfirm={() => {
        const href = pendingHref;
        setPendingHref(null);
        if (href) go(href);
      }}
    />
  );

  return { dialog, requestNavigation };
}
