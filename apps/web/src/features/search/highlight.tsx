import type { SearchHighlight, SearchSnippet } from "@symplist/contracts";
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * Matched text is highlighted as text, never as markup (note 14). The server sends UTF-16 ranges over
 * the exact string it also sends, so the client only has to slice it: anything that looks like HTML
 * or Markdown in the content renders as the characters it is.
 */

interface Segment {
  /** Stable across renders: the segment's offset in the text. */
  readonly start: number;
  readonly text: string;
  readonly match: boolean;
}

/** Clamps, orders and merges ranges, so overlapping or out-of-range input can never drop characters. */
export function highlightSegments(
  text: string,
  highlights: readonly SearchHighlight[],
): readonly Segment[] {
  const ranges = highlights
    .map((range) => ({
      start: Math.max(0, Math.min(range.start, text.length)),
      end: Math.max(0, Math.min(range.end, text.length)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  const segments: Segment[] = [];
  let index = 0;
  for (const range of merged) {
    if (range.start > index) {
      segments.push({ start: index, text: text.slice(index, range.start), match: false });
    }
    segments.push({ start: range.start, text: text.slice(range.start, range.end), match: true });
    index = range.end;
  }
  if (index < text.length) segments.push({ start: index, text: text.slice(index), match: false });
  return segments;
}

export interface HighlightedTextProps {
  readonly text: string;
  readonly highlights?: readonly SearchHighlight[];
  readonly className?: string;
}

/** The text with its matched ranges marked. */
export function HighlightedText({
  text,
  highlights = [],
  className,
}: HighlightedTextProps): ReactNode {
  const segments = highlightSegments(text, highlights);
  return (
    <span className={className} data-slot="highlighted-text">
      {segments.map((segment) =>
        segment.match ? (
          <mark
            key={segment.start}
            className="rounded-[3px] bg-sym-accent-soft px-px text-sym-text [box-decoration-break:clone]"
          >
            {segment.text}
          </mark>
        ) : (
          <Fragment key={segment.start}>{segment.text}</Fragment>
        ),
      )}
    </span>
  );
}

export interface SnippetTextProps {
  readonly snippet: SearchSnippet;
  readonly className?: string;
}

/** A bounded snippet with its match marked and ellipses where the window was cut. */
export function SnippetText({ snippet, className }: SnippetTextProps): ReactNode {
  return (
    <span
      className={cn("text-[13px] text-sym-muted leading-[1.55]", className)}
      data-slot="snippet"
    >
      {snippet.truncatedStart ? <span aria-hidden="true">…</span> : null}
      <HighlightedText text={snippet.text} highlights={snippet.highlights} />
      {snippet.truncatedEnd ? <span aria-hidden="true">…</span> : null}
    </span>
  );
}
