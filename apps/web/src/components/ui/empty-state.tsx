import { cn } from "cn";
import type { ReactNode } from "react";

/**
 * The sample's one small empty-state glyph per theme. All six render and CSS shows only the active
 * theme's, so a theme switch never remounts anything (note 02). Decorative only.
 */
export function ThemeIllustration() {
  return (
    <span aria-hidden="true" className="sym-empty-art">
      <svg
        aria-hidden="true"
        data-for="studio"
        width="28"
        height="20"
        viewBox="0 0 28 20"
        fill="none"
      >
        <rect
          className="sym-art-line"
          x="1"
          y="1"
          width="26"
          height="18"
          rx="3"
          strokeWidth="1.5"
        />
        <path className="sym-art-line" d="M7 8h9M7 12h6" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <svg
        aria-hidden="true"
        data-for="paper"
        width="26"
        height="30"
        viewBox="0 0 26 30"
        fill="none"
      >
        <path
          className="sym-art-line"
          d="M2 2h14l8 8v18H2z"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path className="sym-art-line" d="M16 2v8h8" strokeWidth="1.5" strokeLinejoin="round" />
        <path
          className="sym-art-line"
          d="M7 16h12M7 21h8"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <svg
        aria-hidden="true"
        data-for="pebble"
        width="40"
        height="26"
        viewBox="0 0 40 26"
        fill="none"
      >
        <path className="sym-art-soft" d="M3 18c0-7 6-12 14-12s13 5 13 11-6 8-14 8S3 24 3 18z" />
        <path
          className="sym-art-accent"
          d="M20 12c0-5 5-9 10-9s8 4 8 8-4 7-9 7-9-2-9-6z"
          opacity=".85"
        />
      </svg>
      <svg
        aria-hidden="true"
        data-for="postcard"
        width="34"
        height="34"
        viewBox="0 0 34 34"
        fill="none"
      >
        <rect
          className="sym-art-line"
          x="3"
          y="3"
          width="28"
          height="28"
          strokeWidth="1.5"
          strokeDasharray="3 2.5"
        />
        <rect
          className="sym-art-line sym-art-soft"
          x="9"
          y="9"
          width="16"
          height="16"
          strokeWidth="1.5"
        />
        <circle className="sym-art-accent" cx="17" cy="17" r="3" />
      </svg>
      <svg
        aria-hidden="true"
        data-for="meadow"
        width="40"
        height="34"
        viewBox="0 0 40 34"
        fill="none"
      >
        <path className="sym-art-ok-stroke" d="M20 32V14" strokeWidth="2" strokeLinecap="round" />
        <path className="sym-art-ok" d="M20 22c-6 0-9-4-9-8 5 0 9 3 9 8z" opacity=".8" />
        <path className="sym-art-ok" d="M20 26c6 0 9-4 9-8-5 0-9 3-9 8z" opacity=".6" />
        <circle className="sym-art-accent" cx="20" cy="9" r="6" />
        <circle className="sym-art-panel" cx="20" cy="9" r="2.2" />
      </svg>
      <svg
        aria-hidden="true"
        data-for="tide"
        width="44"
        height="26"
        viewBox="0 0 44 26"
        fill="none"
      >
        <path
          className="sym-art-ink-stroke"
          d="M2 18c5-6 9-6 14 0s9 6 14 0 9-6 12 0"
          strokeWidth="2"
          strokeLinecap="round"
          opacity=".55"
        />
        <path
          className="sym-art-ink-stroke"
          d="M2 24c5-6 9-6 14 0s9 6 14 0 9-6 12 0"
          strokeWidth="2"
          strokeLinecap="round"
          opacity=".3"
        />
        <circle className="sym-art-accent" cx="33" cy="7" r="5" />
      </svg>
    </span>
  );
}

/** The document glyph the sample shows when no task is selected. */
export function PageIllustration() {
  return (
    <svg aria-hidden="true" width="34" height="34" viewBox="0 0 34 34" fill="none">
      <rect className="sym-art-line" x="5" y="3" width="24" height="28" rx="3" strokeWidth="1.5" />
      <path
        className="sym-art-line"
        d="M11 11h12M11 16h12M11 21h7"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly illustration?: ReactNode;
  readonly action?: ReactNode;
  /** `center` fills its region (page area); `start` sits at the top of a list. */
  readonly align?: "start" | "center";
  readonly className?: string;
  /** Heading level for the title when the empty state names a region. */
  readonly headingLevel?: 2 | 3 | null;
}

/** "Nothing here yet" states: one plain sentence, an optional next step, one small glyph at most. */
export function EmptyState({
  title,
  description,
  illustration,
  action,
  align = "start",
  className,
  headingLevel = null,
}: EmptyStateProps) {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "p";
  return (
    <div data-slot="empty-state" data-align={align} className={cn("sym-empty", className)}>
      {illustration ? <div className="flex">{illustration}</div> : null}
      <Title className="sym-empty-title">{title}</Title>
      {description ? <p className="sym-empty-description">{description}</p> : null}
      {action ? <div className="mt-1.5 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}
