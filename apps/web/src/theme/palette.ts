import { compositeOver, contrastRatio, oklchOf, oklchToHex, TEXT_CONTRAST } from "./color.ts";
import {
  type ChromePalette,
  type ColorMode,
  chromePalette,
  type ThemeDefinition,
  type ThemePalette,
} from "./registry.ts";

const STEP = 0.005;

/**
 * Moves a secondary text color toward the primary text color, keeping its hue and chroma, until it
 * reads at 4.5:1 on every backdrop. Returns the original color when it already does.
 */
function readableSecondary(color: string, text: string, backdrops: readonly string[]): string {
  const passes = (candidate: string) =>
    backdrops.every((backdrop) => contrastRatio(candidate, backdrop) >= TEXT_CONTRAST);
  if (passes(color)) return color;
  const start = oklchOf(color);
  const target = oklchOf(text).l;
  const direction = target < start.l ? -1 : 1;
  const steps = Math.ceil(Math.abs(target - start.l) / STEP);
  for (let index = 1; index <= steps; index += 1) {
    const candidate = oklchToHex({ l: start.l + direction * index * STEP, c: start.c, h: start.h });
    if (passes(candidate)) return candidate;
  }
  return text;
}

/**
 * The palette as rendered. Tokens stay exactly as the sample defines them, except that `muted` text is
 * nudged toward `text` where the sample's value falls just short of 4.5:1 on a surface it is drawn on
 * (Pebble Light on its page background, Paper Light on hover), so every theme meets WCAG 2.2 AA.
 */
export function renderedPalette(theme: ThemeDefinition, mode: ColorMode): ThemePalette {
  const palette = theme.palettes[mode];
  const muted = readableSecondary(palette.muted, palette.text, [
    palette.bg,
    palette.panel,
    palette.surface,
    palette.hover,
    palette.codeBg,
  ]);
  return muted === palette.muted ? palette : { ...palette, muted };
}

/** The chrome as rendered, with its muted text held to 4.5:1 on the chrome and its hover fill. */
export function renderedChrome(theme: ThemeDefinition, mode: ColorMode): ChromePalette {
  const chrome = chromePalette(theme, mode);
  const palette = renderedPalette(theme, mode);
  const base = theme.chrome[mode] ? chrome : { ...chrome, muted: palette.muted };
  const muted = readableSecondary(base.muted, base.text, [
    base.bg,
    compositeOver(base.hover, base.bg),
  ]);
  return muted === base.muted ? base : { ...base, muted };
}
