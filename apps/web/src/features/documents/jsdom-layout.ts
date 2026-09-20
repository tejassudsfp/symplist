/**
 * jsdom has no layout, so `Range` and text nodes report no client rects. Both editors ask for them
 * whenever a transaction scrolls the caret into view, and throw without them — which would make
 * every editing test exercise the error path instead of the real one.
 *
 * This is a test-only helper for the documents editor tests: nothing in the app imports it, and real
 * layout is covered by Playwright. It is deliberately local to this feature rather than added to the
 * shared setup file, which several feature branches edit at once.
 */

const emptyRect: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};

function rectList(): DOMRectList {
  const list = [emptyRect] as unknown as DOMRectList;
  Object.defineProperty(list, "item", {
    value: (index: number) => (index === 0 ? emptyRect : null),
  });
  return list;
}

/** Gives `Range`, `Element` and `Text` the zero-sized rects a caret scroll needs. Idempotent. */
export function installJsdomLayout(): void {
  const prototypes = [Range.prototype, Element.prototype, Text.prototype] as unknown as Array<
    Record<string, unknown>
  >;
  for (const prototype of prototypes) {
    if (typeof prototype.getClientRects !== "function") {
      prototype.getClientRects = rectList;
    }
    if (typeof prototype.getBoundingClientRect !== "function") {
      prototype.getBoundingClientRect = () => emptyRect;
    }
  }
}
