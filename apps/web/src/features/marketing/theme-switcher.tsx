"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { accentPresets, resolveAccent } from "@/theme/accent";
import { DEFAULT_APPEARANCE } from "@/theme/appearance";
import { applyAppearance } from "@/theme/appearance-client";
import { renderedPalette } from "@/theme/palette";
import { type ColorMode, type ThemeId, themes } from "@/theme/registry";
import { themeChips } from "./demo-data";

/**
 * The theme switcher under the hero. Choosing one repaints the whole page, not a preview pane.
 *
 * It drives the product's own appearance engine — `applyAppearance` rewrites the appearance stylesheet
 * and the `data-theme` / `data-mode` attributes — so what a visitor sees here is literally what the
 * workspace renders, rather than a marketing approximation that drifts the first time a theme is
 * retuned. `persist: false`, because nobody signed in and a visitor's cookie is not ours to set.
 */
export function ThemeSwitcher({
  onChange,
}: {
  readonly onChange?: (theme: ThemeId, mode: ColorMode) => void;
}) {
  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_APPEARANCE.themeId);
  const [mode, setMode] = useState<ColorMode>("light");

  useEffect(() => {
    applyAppearance({ themeId, mode, accent: DEFAULT_APPEARANCE.accent }, { persist: false });
    onChange?.(themeId, mode);
  }, [themeId, mode, onChange]);

  // The document keeps whatever the visitor last chose while they are on the page; a reload restores
  // the server-rendered default, which is the honest thing for a preference nobody saved.
  return (
    <>
      <fieldset className="sym-theme-switcher">
        <legend className="sr-only">Choose a theme for this page</legend>
        {themeChips.map((chip) => {
          const palette = renderedPalette(themes[chip.id], mode);
          const accent = resolveAccent(accentPresets.blue.seed, themes[chip.id], mode);
          const active = chip.id === themeId;
          return (
            <button
              key={chip.id}
              type="button"
              aria-pressed={active}
              className="sym-theme-chip"
              data-active={active || undefined}
              onClick={() => setThemeId(chip.id)}
            >
              <span
                aria-hidden="true"
                className="sym-theme-chip-dot"
                style={{
                  background: palette.bg,
                  boxShadow: `inset -6px 0 0 ${accent.accent}, 0 0 0 1px rgb(0 0 0 / 0.12)`,
                }}
              />
              {chip.name}
            </button>
          );
        })}
        <span aria-hidden="true" className="sym-theme-switcher-rule" />
        <button
          type="button"
          aria-label={mode === "dark" ? "Switch to light" : "Switch to dark"}
          className="sym-theme-mode"
          onClick={() => setMode(mode === "dark" ? "light" : "dark")}
        >
          {mode === "dark" ? (
            <Sun size={16} strokeWidth={1.9} aria-hidden="true" />
          ) : (
            <Moon size={16} strokeWidth={1.9} aria-hidden="true" />
          )}
        </button>
      </fieldset>
      <p className="sym-theme-caption">
        {`${themes[themeId].name} · ${themes[themeId].tag}. The whole page follows — this is the real theme, not a picture of one.`}
      </p>
    </>
  );
}
