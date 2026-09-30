"use client";

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_APPEARANCE } from "@/theme/appearance";
import { applyAppearance } from "@/theme/appearance-client";
import type { ColorMode, ThemeId } from "@/theme/registry";

/**
 * The appearance the public page is currently wearing.
 *
 * Two controls set it — the switcher under the hero and the six theme cards further down — and both
 * repaint the whole document rather than a preview pane, so the state has to live above them. It
 * drives the product's own engine: `applyAppearance` rewrites the appearance stylesheet and the
 * `data-theme` / `data-mode` attributes, which means a visitor sees literally what the workspace
 * renders instead of a marketing approximation that drifts the first time a theme is retuned.
 *
 * `persist: false`, because nobody signed in and a visitor's cookie is not ours to set.
 */

interface PageAppearance {
  readonly themeId: ThemeId;
  readonly mode: ColorMode;
  readonly setThemeId: (id: ThemeId) => void;
  readonly setMode: (mode: ColorMode) => void;
}

const PageAppearanceContext = createContext<PageAppearance | null>(null);

export function PageAppearanceProvider({ children }: { readonly children: ReactNode }) {
  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_APPEARANCE.themeId);
  /*
   * `null` until the browser tells us what the server's `system` mode actually resolved to. Starting
   * at `light` would flash a dark-mode visitor's page white for a frame before the switcher agreed
   * with their device.
   */
  const [mode, setMode] = useState<ColorMode | null>(null);

  useEffect(() => {
    if (mode === null) {
      setMode(window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      return;
    }
    applyAppearance({ themeId, mode, accent: DEFAULT_APPEARANCE.accent }, { persist: false });
  }, [themeId, mode]);

  const resolved: ColorMode = mode ?? "light";
  const value = useMemo<PageAppearance>(
    () => ({ themeId, mode: resolved, setThemeId, setMode }),
    [themeId, resolved],
  );

  return <PageAppearanceContext.Provider value={value}>{children}</PageAppearanceContext.Provider>;
}

export function usePageAppearance(): PageAppearance {
  const value = useContext(PageAppearanceContext);
  if (value === null) {
    throw new Error("usePageAppearance must be used inside PageAppearanceProvider");
  }
  return value;
}
