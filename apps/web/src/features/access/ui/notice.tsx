"use client";

import { cn } from "cn";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import type { ReactNode } from "react";

export type NoticeTone = "info" | "success" | "warning" | "error";

export interface NoticeProps {
  readonly tone?: NoticeTone;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  /** Buttons for the next step, such as Try again. */
  readonly actions?: ReactNode;
  readonly className?: string;
  /**
   * Errors are announced as alerts and other tones as polite status messages. Pass `none` for notices
   * rendered with the page (they are read in document order, not announced).
   */
  readonly live?: "auto" | "none";
}

const toneClass: Record<NoticeTone, string> = {
  info: "border-sym-line bg-sym-surface",
  success: "border-sym-line bg-sym-ok-soft",
  warning: "border-sym-line bg-sym-warn-soft",
  error: "border-sym-line-strong bg-sym-surface",
};

function ToneIcon({ tone }: { tone: NoticeTone }) {
  const props = { size: 15, strokeWidth: 2, "aria-hidden": true } as const;
  switch (tone) {
    case "success":
      return <CircleCheck {...props} className="mt-px shrink-0 text-sym-ok" />;
    case "warning":
      return <CircleAlert {...props} className="mt-px shrink-0 text-sym-warn" />;
    case "error":
      return <CircleAlert {...props} className="mt-px shrink-0 text-sym-danger" />;
    case "info":
      return <Info {...props} className="mt-px shrink-0 text-sym-muted" />;
  }
}

/**
 * A calm inline message: what happened and what to do next (system_states.md). Never a red alert
 * wall; the tone shows through a small icon and a soft tint, and the text always carries the meaning.
 */
export function Notice({
  tone = "info",
  title,
  children,
  actions,
  className,
  live = "auto",
}: NoticeProps) {
  const role = live === "none" ? undefined : tone === "error" ? "alert" : "status";
  return (
    <div
      role={role}
      data-slot="access-notice"
      data-tone={tone}
      className={cn(
        "flex gap-2.5 rounded-sym-lg border px-3 py-2.5 text-[13.5px] leading-normal",
        toneClass[tone],
        className,
      )}
    >
      <ToneIcon tone={tone} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title ? <p className="m-0 font-medium text-sym-text">{title}</p> : null}
        {children ? <div className="m-0 text-sym-text [text-wrap:pretty]">{children}</div> : null}
        {actions ? <div className="mt-1 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
