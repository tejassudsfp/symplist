import { accentSeed, type ResolvedAccent, resolveAccent } from "./accent.ts";
import type { Appearance } from "./appearance.ts";
import { renderedChrome, renderedPalette } from "./palette.ts";
import {
  type ColorMode,
  type FontFamilyId,
  type FontRole,
  type ThemeDefinition,
  themes,
} from "./registry.ts";

/** The CSS custom property that `next/font/local` sets for a self-hosted family (see `app/fonts.ts`). */
export function fontVariable(family: FontFamilyId): `--font-${FontFamilyId}` {
  return `--font-${family}`;
}

function fontStack(role: FontRole): string {
  return `var(${fontVariable(role.family)}), ${role.fallback}`;
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Mode-independent theme variables: geometry, fonts and component variants. */
export function themeGeometryVariables(theme: ThemeDefinition): Record<string, string> {
  const { geometry, variants, fonts } = theme;
  const variables: Record<string, string> = {
    "--sym-font": fontStack(fonts.ui),
    "--sym-head-font": fontStack(fonts.heading),
    "--sym-mono": fontStack(fonts.mono),
    "--sym-r": geometry.r,
    "--sym-rl": geometry.rl,
    "--sym-rc": geometry.rc,
    "--sym-bubble": geometry.bubble,
    "--sym-row-pad": geometry.rowPad,
    "--sym-h2-size": geometry.h2Size,
    "--sym-h2-pad": geometry.h2Pad,
    "--sym-h2-rule": geometry.h2Rule ? "1px solid var(--sym-line)" : "0",
    "--sym-panel-inset": geometry.panelInset,
    "--sym-panel-radius": geometry.panelRadius,
    "--sym-panel-border": geometry.panelBorder ? "1.5px solid var(--sym-line)" : "0",
    "--sym-panel-shadow": geometry.panelShadow,
    // Flat themes separate panels with a 1 px rule; inset themes float framed panels instead.
    "--sym-panel-divider": geometry.panelInset === "0" ? "1px solid var(--sym-line)" : "0",
    "--sym-panel-frame-shadow":
      geometry.panelInset === "0"
        ? "none"
        : [
            geometry.panelBorder ? "inset 0 0 0 1.5px var(--sym-line)" : null,
            geometry.panelShadow === "none" ? null : geometry.panelShadow,
          ]
            .filter((value): value is string => value !== null)
            .join(", ") || "none",
    "--sym-sheet-bg": geometry.sheet ? "var(--sym-surface)" : "transparent",
    "--sym-sheet-border": geometry.sheet
      ? `${variants.sheetBorderWidth} solid var(--sym-line)`
      : "0",
    "--sym-sheet-shadow": geometry.sheet
      ? variants.sheetShadow === "card"
        ? geometry.cardShadow
        : "0 1px 0 var(--sym-line-strong)"
      : "none",
    "--sym-sheet-pad": geometry.sheetPad,
    "--sym-sheet-max": geometry.sheetMax,
    "--sym-marker-w": geometry.markerW,
    "--sym-marker-r": geometry.markerR,
    "--sym-marker-inset": geometry.markerInset,
    "--sym-marker-left": geometry.markerLeft,
    "--sym-card-shadow": geometry.cardShadow,
    "--sym-card-border":
      geometry.cardBorder === "0" ? "0" : `${geometry.cardBorder} solid var(--sym-line)`,
    "--sym-input-border":
      variants.inputBorder === "line" ? "var(--sym-line)" : "var(--sym-line-strong)",
  };
  return variables;
}

/** Mode-dependent color variables: the theme palette, chrome and the resolved accent tokens. */
export function themeColorVariables(
  theme: ThemeDefinition,
  mode: ColorMode,
  accent: ResolvedAccent,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [token, value] of Object.entries(renderedPalette(theme, mode))) {
    variables[`--sym-${kebab(token)}`] = value;
  }
  const chrome = renderedChrome(theme, mode);
  variables["--sym-chrome-bg"] = chrome.bg;
  variables["--sym-chrome-line"] = chrome.line;
  variables["--sym-chrome-text"] = chrome.text;
  variables["--sym-chrome-muted"] = chrome.muted;
  variables["--sym-chrome-hover"] = chrome.hover;
  const { adjusted: _adjusted, ...tokens } = accent;
  for (const [token, value] of Object.entries(tokens)) {
    variables[`--sym-${kebab(token)}`] = value;
  }
  return variables;
}

const unsafeValue = /[;{}<>\\]|\/\*|\*\//;

function declarations(variables: Record<string, string>): string {
  return Object.entries(variables)
    .map(([name, value]) => {
      if (!/^--[a-z0-9-]+$/.test(name) || unsafeValue.test(value)) {
        throw new Error(`Refusing to emit unsafe CSS declaration ${name}`);
      }
      return `${name}:${value};`;
    })
    .join("");
}

/**
 * The stylesheet for one appearance: geometry, both palettes with their resolved accents, and the
 * `system` mode mapped through `prefers-color-scheme` (§10.3). Every value comes from the registry
 * or a validated hex seed, and emitted declarations are checked again before joining.
 */
export function buildAppearanceCss(appearance: Appearance): string {
  const theme = themes[appearance.themeId];
  const seed = accentSeed(appearance.accent);
  const root = `:root[data-theme="${theme.id}"]`;
  const light = declarations(
    themeColorVariables(theme, "light", resolveAccent(seed, theme, "light")),
  );
  const dark = declarations(themeColorVariables(theme, "dark", resolveAccent(seed, theme, "dark")));
  return [
    `${root}{${declarations(themeGeometryVariables(theme))}}`,
    `${root}[data-mode="light"],${root}[data-mode="system"]{color-scheme:light;${light}}`,
    `${root}[data-mode="dark"]{color-scheme:dark;${dark}}`,
    `@media (prefers-color-scheme: dark){${root}[data-mode="system"]{color-scheme:dark;${dark}}}`,
  ].join("\n");
}
