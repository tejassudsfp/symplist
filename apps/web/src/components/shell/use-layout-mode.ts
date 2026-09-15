"use client";

import { useSyncExternalStore } from "react";
import { DESKTOP_MIN_WIDTH, type LayoutMode, MOBILE_MAX_WIDTH } from "./shell-state.ts";

const desktopQuery = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;
const mobileQuery = `(max-width: ${MOBILE_MAX_WIDTH + 0.98}px)`;

function currentMode(): LayoutMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "desktop";
  if (window.matchMedia(desktopQuery).matches) return "desktop";
  if (window.matchMedia(mobileQuery).matches) return "mobile";
  return "laptop";
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return () => undefined;
  const queries = [window.matchMedia(desktopQuery), window.matchMedia(mobileQuery)];
  for (const query of queries) query.addEventListener("change", onChange);
  return () => {
    for (const query of queries) query.removeEventListener("change", onChange);
  };
}

/**
 * The layout mode from the same breakpoints the stylesheet uses. CSS does the actual layout, so the
 * server snapshot (desktop) never causes a visible flash; this hook only decides behavior such as
 * whether panels can be resized and what the rail's collection button toggles.
 */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, currentMode, () => "desktop");
}
