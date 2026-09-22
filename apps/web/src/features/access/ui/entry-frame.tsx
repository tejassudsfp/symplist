"use client";

import { cn } from "cn";
import { forwardRef, type ReactNode, useEffect, useRef } from "react";
import { SymplistLogo } from "@/components/brand/logo";
import { ThemeIllustration } from "@/components/ui/empty-state";

/** The small wordmark shown above entry, gate and onboarding screens. */
export function Wordmark() {
  return <SymplistLogo className="text-[15px] text-sym-text" />;
}

export interface EntryFrameProps {
  readonly children: ReactNode;
  /** Top-right controls, such as the reduced account menu on the gate. */
  readonly headerEnd?: ReactNode;
  /**
   * One small theme motif above the form (email_entry.md). Restriction and failure screens leave it
   * out (access_revoked.md).
   */
  readonly motif?: boolean;
  /** Wider column for the connections step. */
  readonly width?: "narrow" | "wide";
}

/**
 * The frame for screens outside the workspace (sign-in, the beta gate, paused access, onboarding): a
 * quiet header with the wordmark, one centered column that stays near the top on phones so the
 * keyboard never covers the form, and a restrained attribution footer. It is an application entry,
 * not a landing page.
 */
export function EntryFrame({
  children,
  headerEnd,
  motif = false,
  width = "narrow",
}: EntryFrameProps) {
  return (
    <div className="flex min-h-dvh flex-col bg-sym-bg text-sym-text">
      <header className="flex h-14 flex-none items-center justify-between gap-3 px-5 sm:px-8">
        <Wordmark />
        {headerEnd ? <div className="flex items-center gap-2">{headerEnd}</div> : null}
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col items-center px-5 pt-6 pb-10 outline-none sm:justify-center sm:pt-0 sm:pb-16"
      >
        <div
          className={cn(
            "flex w-full flex-col gap-5",
            width === "wide" ? "max-w-[560px]" : "max-w-[400px]",
          )}
        >
          {motif ? (
            <div className="flex" data-slot="theme-motif">
              <ThemeIllustration />
            </div>
          ) : null}
          {children}
        </div>
      </main>
      <footer className="flex flex-none flex-wrap items-center justify-center gap-x-2 gap-y-1 px-5 pb-5 text-[12px] text-sym-muted">
        <span>MIT open source by Tejas Parthasarathi Sudarshan</span>
        <span aria-hidden="true">·</span>
        <a
          href="https://tejassuds.com"
          className="text-sym-muted underline underline-offset-2 hover:text-sym-text"
          rel="noopener noreferrer"
        >
          tejassuds.com
        </a>
      </footer>
    </div>
  );
}

export interface ScreenHeadingProps {
  readonly children: ReactNode;
  /** Moves focus to the heading when it mounts, for screens reached unexpectedly (access_revoked.md). */
  readonly focusOnMount?: boolean;
  readonly className?: string;
}

/** The page's `h1`, focusable so an unexpected transition can move focus to what changed. */
export const ScreenHeading = forwardRef<HTMLHeadingElement, ScreenHeadingProps>(
  function ScreenHeading({ children, focusOnMount = false, className }, forwardedRef) {
    const localRef = useRef<HTMLHeadingElement | null>(null);
    useEffect(() => {
      if (focusOnMount) localRef.current?.focus();
    }, [focusOnMount]);
    return (
      <h1
        ref={(node) => {
          localRef.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        tabIndex={-1}
        className={cn(
          "m-0 font-heading font-semibold text-[22px] text-sym-text leading-tight tracking-[-0.015em] outline-none",
          className,
        )}
      >
        {children}
      </h1>
    );
  },
);

/** Supporting copy under a screen heading. */
export function Lede({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn("m-0 text-[14px] text-sym-muted leading-relaxed [text-wrap:pretty]", className)}
    >
      {children}
    </p>
  );
}
