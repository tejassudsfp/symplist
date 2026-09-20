"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { RouteState } from "@/components/ui/route-state";

export default function RouteError({
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <main className="sym-route-state-shell">
      <RouteState
        alert
        headingRef={heading}
        title="This page couldn’t be opened"
        description="Something unexpected happened. Your saved work is unchanged."
        action={
          <>
            <Button variant="primary" onClick={reset}>
              Try this page again
            </Button>
            <a href="/now">Return to tasks</a>
          </>
        }
      />
    </main>
  );
}
