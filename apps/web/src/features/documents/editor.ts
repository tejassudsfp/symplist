import type { ViewPosition } from "./sections.ts";

/**
 * What the task page asks of either editor view. Switching views moves the caret through
 * {@link EditorHandle.position} and {@link EditorHandle.setPosition}, so the person stays in the same
 * section (§9.3), and "Find in document" (note 13) drives the same handle in both views.
 */
export interface EditorHandle {
  focus(): void;
  /** The caret's section and in-section offset. */
  position(): ViewPosition;
  setPosition(position: ViewPosition, options?: { readonly focus?: boolean }): void;
  /**
   * Selects and scrolls to the `index`-th case-insensitive match of `query` (wrapping) and returns
   * how many matches the view holds. An empty query clears the selection and returns 0.
   */
  showMatch(query: string, index: number): number;
  clearMatch(): void;
}

/** Every case-insensitive match of `query` in `text`, as `[start, end)` UTF-16 ranges. */
export function matchesOf(text: string, query: string): Array<[number, number]> {
  if (query.length === 0) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const found: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    found.push([at, at + needle.length]);
    from = at + Math.max(1, needle.length);
    if (found.length >= 500) break;
  }
  return found;
}

/** Wraps a match index into range, so Next past the last match returns to the first. */
export function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}
