import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * jsdom has no layout, so it ships no ResizeObserver. The panel library observes element sizes; a
 * silent observer is enough for component tests, and real layout is covered by Playwright.
 */
class NoLayoutResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = NoLayoutResizeObserver;
}

afterEach(() => {
  cleanup();
});
