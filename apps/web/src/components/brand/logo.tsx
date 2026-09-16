import type { ReactElement } from "react";

/*
 * The Symplist mark. Three rows on a 24-unit grid, line lengths stepping down 11.0 / 7.4 / 3.8 by a
 * constant 3.6, stroke 2.2, round caps. The arithmetic is the mark: nothing here is eyeballed, so it
 * redraws identically at any size.
 *
 * It is drawn in `currentColor` and never carries a colour of its own, because the app ships six
 * themes in light and dark with a user-chosen accent and the mark has to sit correctly on all of
 * them. The wordmark is pinned to Geist rather than the active theme's `--sym-font`: a wordmark is
 * an identity and must not change when someone switches from Studio to Paper.
 */

export type SymplistLogoProps = {
  /** Renders the wordmark beside the mark. Omit for the mark alone. */
  readonly withWordmark?: boolean;
  /** Stacks the wordmark under the mark, for narrow spaces. */
  readonly stacked?: boolean;
  /**
   * Accessible name. Pass `null` when a visible label already names the element, so a screen reader
   * does not hear the product name twice.
   */
  readonly label?: string | null;
  readonly className?: string;
};

export function SymplistMark({ className }: { readonly className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true" focusable="false">
      <circle cx="4.7" cy="6.5" r="1.35" fill="currentColor" />
      <circle cx="4.7" cy="12" r="1.35" fill="currentColor" />
      <circle cx="4.7" cy="17.5" r="1.35" fill="currentColor" />
      <path
        d="M9.1 6.5H20.1M9.1 12H16.5M9.1 17.5H12.9"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SymplistLogo({
  withWordmark = true,
  stacked = false,
  label = "Symplist",
  className,
}: SymplistLogoProps): ReactElement {
  const classes = [
    "sym-logo",
    stacked ? "sym-logo--stacked" : undefined,
    withWordmark ? undefined : "sym-logo--mark-only",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  // With the wordmark present the name is already readable, so the group needs no image role.
  const naming =
    label === null || withWordmark ? {} : ({ role: "img", "aria-label": label } as const);
  return (
    <span className={classes} {...naming}>
      <SymplistMark className="sym-logo__mark" />
      {withWordmark ? <span className="sym-logo__word">symplist</span> : null}
    </span>
  );
}
