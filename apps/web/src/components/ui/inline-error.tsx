"use client";

import { cn } from "cn";
import { useState } from "react";
import { Button } from "./button.tsx";

export interface InlineErrorProps {
  /** What happened, for example "Couldn't load Now". */
  readonly title: string;
  /** What the user can do next, in plain language without internal system names. */
  readonly description: string;
  /** Retry handler; while its promise is pending the button reports progress and cannot repeat. */
  readonly onRetry?: () => void | Promise<void>;
  readonly retryLabel?: string;
  readonly className?: string;
}

/**
 * Region-level failure with a retry (sample list fetch error). It replaces only the failed region and
 * is announced once as an alert.
 */
export function InlineError({
  title,
  description,
  onRetry,
  retryLabel = "Try again",
  className,
}: InlineErrorProps) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div role="alert" data-slot="inline-error" className={cn("sym-inline-error", className)}>
      <p className="sym-inline-error-title">{title}</p>
      <p className="sym-inline-error-description">{description}</p>
      {onRetry ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void retry();
          }}
          disabled={retrying}
          aria-busy={retrying || undefined}
        >
          {retrying ? "Trying again…" : retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
