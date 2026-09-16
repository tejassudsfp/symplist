"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { signInPathFor } from "../navigation.ts";
import type { SessionLoadError } from "../session-store.ts";
import {
  getSignOutState,
  resetSignOutState,
  type SignOutState,
  subscribeSignOutState,
} from "../sign-out.ts";
import { EntryFrame, Lede, ScreenHeading } from "../ui/entry-frame.tsx";
import { Notice } from "../ui/notice.tsx";

/** The first read of the session: a quiet status in the entry frame, never protected content. */
export function SessionLoading({ label = "Loading Symplist…" }: { label?: string }) {
  return (
    <div
      className="flex min-h-dvh items-center justify-center bg-sym-bg text-[13.5px] text-sym-muted"
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-slot="session-loading"
    >
      <span className="flex items-center gap-2">
        <Spinner size={13} />
        {label}
      </span>
    </div>
  );
}

/** The identity could not be read: say so plainly and offer a retry (system_states.md). */
export function SessionLoadFailed({
  error,
  onRetry,
  retrying,
}: {
  error: SessionLoadError;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <EntryFrame>
      <ScreenHeading focusOnMount>Couldn't open Symplist</ScreenHeading>
      <Notice tone="error">
        {error === "network"
          ? "Symplist couldn't be reached. Check your connection, then try again."
          : "Something went wrong on our side. Try again in a moment."}
      </Notice>
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        onClick={onRetry}
        disabled={retrying}
        aria-busy={retrying || undefined}
      >
        {retrying ? <Spinner size={12} /> : null}
        {retrying ? "Trying again…" : "Try again"}
      </Button>
    </EntryFrame>
  );
}

/**
 * The session ended while this page was open (logout elsewhere, revocation, expiry). Protected content
 * is gone; signing in again returns to the same place (access_revoked.md session-expired variant).
 */
export function SessionExpired({ returnPath }: { returnPath: string }) {
  return (
    <EntryFrame>
      <ScreenHeading focusOnMount>Your session has ended</ScreenHeading>
      <Lede>
        For your security you've been signed out. Sign in again with a code sent to your email to
        continue. Changes that weren't saved before the session ended may not have been kept.
      </Lede>
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        onClick={() => window.location.assign(signInPathFor(returnPath, { expired: true }))}
      >
        Sign in again
      </Button>
    </EntryFrame>
  );
}

/** Shown for the moment between deciding a redirect and the next screen rendering. */
export function Redirecting({ label }: { label: string }) {
  return <SessionLoading label={label} />;
}

/** A signed-in account without the admin role opened an administration address (system_states.md). */
export function AdminRequired() {
  return (
    <section
      className="mx-auto flex max-w-[440px] flex-col gap-3 px-5 py-16"
      aria-labelledby="admin-required"
    >
      <h1 id="admin-required" className="m-0 font-heading font-semibold text-[20px]" tabIndex={-1}>
        You don't have access to this page
      </h1>
      <p className="m-0 text-[14px] text-sym-muted">
        This page is only available to the people who run this Symplist deployment.
      </p>
      <div>
        <a className="text-sym-link underline-offset-2 hover:underline" href="/now">
          Back to your tasks
        </a>
      </div>
    </section>
  );
}

export function useSignOutState(): SignOutState {
  return useSyncExternalStore(subscribeSignOutState, getSignOutState, getSignOutState);
}

/**
 * Sign-out progress and failure for every screen (profile_menu.md): "Signing out…" while the api is
 * asked, and a plain failure with Try again when it could not be reached. The person stays signed in
 * on failure; nothing claims a sign-out that did not happen.
 */
export function SignOutFeedback({ onRetry }: { onRetry: () => void }) {
  const state = useSignOutState();
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) resetSignOutState();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);
  if (state.kind === "idle") return null;
  return (
    <div
      className="fixed inset-x-0 bottom-[calc(18px+env(safe-area-inset-bottom,0px))] z-[70] flex justify-center px-5"
      data-slot="sign-out-feedback"
    >
      {state.kind === "signing_out" ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-sym-lg bg-sym-ink px-3.5 py-2 text-[13px] text-sym-on-ink shadow-lg"
        >
          <Spinner size={11} />
          {state.reason === "account_deleted" ? "Finishing deletion…" : "Signing out…"}
        </div>
      ) : (
        <div
          role="alert"
          className="flex max-w-[420px] flex-wrap items-center gap-3 rounded-sym-lg bg-sym-ink px-3.5 py-2 text-[13px] text-sym-on-ink shadow-lg"
        >
          <span>
            {state.reason === "network"
              ? "Couldn't sign out: Symplist couldn't be reached. You're still signed in."
              : "Couldn't sign out. You're still signed in."}
          </span>
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={onRetry}
          >
            Try again
          </button>
          <button
            type="button"
            className="text-sym-on-ink/80 underline-offset-2 hover:underline"
            onClick={resetSignOutState}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
