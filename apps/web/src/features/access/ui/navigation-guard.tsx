"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { currentPathname, navigateAcrossGroups, needsDocumentNavigation } from "../navigation.ts";

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

const historyGuardKey = "__symplistNavigationGuard";
type PendingNavigation =
  | { readonly kind: "href"; readonly href: string }
  | { readonly kind: "back" };

function historyGuardToken(state: unknown): unknown {
  if (typeof state !== "object" || state === null) return undefined;
  return (state as Record<string, unknown>)[historyGuardKey];
}

/**
 * Asks before leaving a screen with something at stake (unsaved name edits, unacknowledged one-time
 * codes): link clicks and same-document browser Back are held for a decision, and closing or
 * reloading the tab raises the browser's own prompt. Leaving is always possible; the dialog only
 * makes it explicit (settings_account.md, admin_invite_create.md, system_states.md).
 */
export function useNavigationGuard(active: boolean, copy: NavigationGuardCopy): NavigationGuard {
  const router = useRouter();
  const token = useId();
  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const activeRef = useRef(active);
  const bypassRef = useRef(false);
  const sentinelInstalled = useRef(false);
  const restoringSentinel = useRef(false);
  const lifecycle = useRef(0);

  const ownsCurrentSentinel = useCallback(
    () => historyGuardToken(window.history.state) === token,
    [token],
  );

  const installSentinel = useCallback(() => {
    if (sentinelInstalled.current && ownsCurrentSentinel()) return;
    const current = window.history.state;
    const state = typeof current === "object" && current !== null ? current : {};
    window.history.pushState({ ...state, [historyGuardKey]: token }, "", window.location.href);
    sentinelInstalled.current = true;
  }, [ownsCurrentSentinel, token]);

  const retireSentinel = useCallback(() => {
    if (!sentinelInstalled.current) return;
    sentinelInstalled.current = false;
    restoringSentinel.current = false;
    if (!ownsCurrentSentinel()) return;
    // Return to the real copy of this same URL. The now-forward sentinel is harmless and the next
    // ordinary push replaces it; importantly, Back once again reaches the preceding route.
    bypassRef.current = true;
    window.history.back();
  }, [ownsCurrentSentinel]);

  useEffect(() => {
    lifecycle.current++;
    activeRef.current = active;
    if (active) installSentinel();
    else {
      setPending(null);
      retireSentinel();
    }
    return () => {
      const cleanupGeneration = ++lifecycle.current;
      queueMicrotask(() => {
        // React Strict Mode immediately sets the effect up again. Only a real unmount reaches here
        // with the same generation, so its rehearsal cannot add/remove history entries or prompt.
        if (lifecycle.current !== cleanupGeneration) return;
        activeRef.current = false;
        retireSentinel();
      });
    };
  }, [active, installSentinel, retireSentinel]);

  const go = useCallback(
    (href: string) => {
      bypassRef.current = true;
      const replaceSentinel = sentinelInstalled.current && ownsCurrentSentinel();
      sentinelInstalled.current = false;
      restoringSentinel.current = false;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) {
        if (replaceSentinel) window.location.replace(url.href);
        else window.location.assign(url.href);
        return;
      }
      const path = `${url.pathname}${url.search}${url.hash}`;
      // A document navigation unloads this page after the current task, so the bypass has to outlive
      // the microtask queue or `beforeunload` would prompt again for a departure already confirmed.
      const leaving = needsDocumentNavigation(currentPathname(), path);
      navigateAcrossGroups(router, path, { replace: replaceSentinel });
      if (leaving) return;
      // Client navigations keep this component mounted until the route changes.
      queueMicrotask(() => {
        bypassRef.current = false;
      });
    },
    [ownsCurrentSentinel, router],
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
      setPending({
        kind: "href",
        href: url.origin === here.origin ? `${url.pathname}${url.search}${url.hash}` : url.href,
      });
    };
    const onPopState = (event: PopStateEvent) => {
      if (bypassRef.current) {
        bypassRef.current = false;
        return;
      }
      if (!activeRef.current) return;
      if (restoringSentinel.current) {
        if (historyGuardToken(event.state) === token) {
          restoringSentinel.current = false;
          sentinelInstalled.current = true;
          setPending({ kind: "back" });
        } else {
          // A browser history menu can jump more than one entry. Walk forward until the guarded
          // duplicate is restored before showing a decision, so protected state never unmounts.
          window.history.forward();
        }
        return;
      }
      if (historyGuardToken(event.state) === token) return;
      restoringSentinel.current = true;
      window.history.forward();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onClick, true);
    };
  }, [token]);

  const requestNavigation = useCallback(
    (href: string) => {
      if (activeRef.current) setPending({ kind: "href", href });
      else go(href);
    },
    [go],
  );

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      cancelLabel={copy.cancelLabel}
      initialFocus="cancel"
      onConfirm={() => {
        const navigation = pending;
        setPending(null);
        if (!navigation) return;
        if (navigation.kind === "href") {
          go(navigation.href);
          return;
        }
        // We are on the artificial duplicate. Skip it and the original copy of this route to
        // perform the Back the person already requested.
        bypassRef.current = true;
        sentinelInstalled.current = false;
        window.history.go(-2);
      }}
    />
  );

  return { dialog, requestNavigation };
}
