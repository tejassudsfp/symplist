"use client";

import type { CSSProperties } from "react";
import { useMemo } from "react";
import { type AccentChoice, accentSeed, resolveAccent } from "@/theme/accent";
import { themeColorVariables, themeGeometryVariables } from "@/theme/css";
import { type ColorMode, type ThemeId, themes } from "@/theme/registry";

/** The theme's own variables as an inline style, so a preview renders in a theme that is not applied. */
export function useThemeVariables(
  themeId: ThemeId,
  mode: ColorMode,
  accent: AccentChoice,
): CSSProperties {
  return useMemo(() => {
    const theme = themes[themeId];
    const resolved = resolveAccent(accentSeed(accent), theme, mode);
    return {
      ...themeGeometryVariables(theme),
      ...themeColorVariables(theme, mode, resolved),
    } as CSSProperties;
  }, [themeId, mode, accent]);
}

export interface ThemeMiniatureProps {
  readonly themeId: ThemeId;
  readonly mode: ColorMode;
  readonly accent: AccentChoice;
}

/**
 * A miniature of the real workspace — task list, page and chat — drawn with the theme's own tokens,
 * typography and panel treatment (note 02: a palette alone is not enough). Decorative: the card's
 * control carries the name and the selected state.
 */
export function ThemeMiniature({ themeId, mode, accent }: ThemeMiniatureProps) {
  const style = useThemeVariables(themeId, mode, accent);
  return (
    <span aria-hidden="true" className="sym-theme-mini" style={style}>
      <span className="sym-theme-mini-rail">
        <span className="sym-theme-mini-dot" data-active="true" />
        <span className="sym-theme-mini-dot" />
        <span className="sym-theme-mini-dot" />
      </span>
      <span className="sym-theme-mini-list">
        <span className="sym-theme-mini-row" data-selected="true">
          Refresh my portfolio
        </span>
        <span className="sym-theme-mini-row">Send the project outline</span>
        <span className="sym-theme-mini-row">Book a bike tune-up</span>
      </span>
      <span className="sym-theme-mini-page">
        <span className="sym-theme-mini-heading">Portfolio refresh</span>
        <span className="sym-theme-mini-line" />
        <span className="sym-theme-mini-line" data-short="true" />
        <span className="sym-theme-mini-button">Save</span>
      </span>
      <span className="sym-theme-mini-chat">
        <span className="sym-theme-mini-bubble">Which sections need work?</span>
        <span className="sym-theme-mini-reply" />
      </span>
    </span>
  );
}

/** The rendered accent for one theme and mode, next to the seed the person chose. */
export function useResolvedAccent(themeId: ThemeId, mode: ColorMode, accent: AccentChoice) {
  return useMemo(
    () => resolveAccent(accentSeed(accent), themes[themeId], mode),
    [themeId, mode, accent],
  );
}
