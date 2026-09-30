"use client";

import { Moon, Sun } from "lucide-react";
import { accentPresets, resolveAccent } from "@/theme/accent";
import { renderedPalette } from "@/theme/palette";
import { themes } from "@/theme/registry";
import { usePageAppearance } from "./appearance";
import { themeChips, themeFontLabels } from "./demo-data";

/**
 * The theme switcher under the hero. Choosing one repaints the whole page, not a preview pane.
 *
 * Each chip carries the theme it names: the swatch is that theme's page colour with its resolved
 * accent cut into the right half, both read from the live registry at render time.
 */
export function ThemeSwitcher() {
  const { themeId, mode, setThemeId, setMode } = usePageAppearance();

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
        {`${themes[themeId].name}, ${mode} · ${themeFontLabels[themeId]}`}
      </p>
    </>
  );
}
