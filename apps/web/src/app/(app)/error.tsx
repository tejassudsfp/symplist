"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { RouteState } from "@/components/ui/route-state";

export default function AppRouteError({
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <RouteState
      embedded
      alert
      headingRef={heading}
      title="This view couldn’t be opened"
      description="Your saved work is unchanged. Other parts of Symplist are still available."
      action={
        <Button variant="primary" onClick={reset}>
          Try this view again
        </Button>
      }
    />
  );
}
