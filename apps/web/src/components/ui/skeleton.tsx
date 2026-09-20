import { cn } from "cn";
import type { ComponentProps } from "react";

/** One skeleton bar. Decorative: the surrounding region announces that it is loading. */
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn("sym-skeleton", className)}
      {...props}
    />
  );
}

const defaultWidths = ["62%", "78%", "48%"] as const;

/**
 * Region-level loading placeholder from the sample: a few pulsing lines with staggered delays. The
 * pulse stops under reduced motion. Only the loading region is replaced, never the whole app.
 */
function SkeletonLines({
  label,
  widths = defaultWidths,
  className,
}: {
  /** Accessible description, for example "Loading tasks". */
  label: string;
  widths?: readonly string[];
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn("flex flex-col gap-3.5 px-2 py-1.5", className)}
    >
      <span className="sr-only">{label}</span>
      {widths.map((width, index) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: static decorative bars never reorder.
          key={index}
          className="h-[13px]"
          style={{ width, animationDelay: `${index * 0.15}s` }}
        />
      ))}
    </div>
  );
}

export { Skeleton, SkeletonLines };
