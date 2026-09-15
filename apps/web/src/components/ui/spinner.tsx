import { cn } from "cn";

/**
 * A small progress ring. Decorative by default (pair it with visible or announced text); under
 * reduced motion the global rule stops the rotation, leaving a static glyph.
 */
export function Spinner({
  size = 12,
  label,
  className,
}: {
  size?: number;
  /** When set, the spinner is announced as an image with this name. */
  label?: string;
  className?: string;
}) {
  return (
    <span
      data-slot="spinner"
      className={cn("sym-spinner", className)}
      style={{ width: size, height: size }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}
