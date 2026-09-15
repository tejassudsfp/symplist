import {
  compositeOver,
  contrastRatio,
  isHexColor,
  oklchOf,
  oklchToHex,
  relativeLuminance,
  TEXT_CONTRAST,
  UI_CONTRAST,
} from "./color.ts";
import { renderedChrome, renderedPalette } from "./palette.ts";
import type { ColorMode, ThemeDefinition, ThemePalette } from "./registry.ts";

/** Named accent presets (note 02). A preset id is stored; its seed is resolved per theme and mode. */
export const accentPresetIds = [
  "blue",
  "violet",
  "rose",
  "coral",
  "amber",
  "green",
  "teal",
  "graphite",
] as const;
export type AccentPresetId = (typeof accentPresetIds)[number];

export interface AccentPreset {
  readonly id: AccentPresetId;
  readonly label: string;
  readonly seed: string;
}

export const accentPresets: Readonly<Record<AccentPresetId, AccentPreset>> = {
  blue: { id: "blue", label: "Blue", seed: "#2F5FD0" },
  violet: { id: "violet", label: "Violet", seed: "#7048E8" },
  rose: { id: "rose", label: "Rose", seed: "#D6336C" },
  coral: { id: "coral", label: "Coral", seed: "#E25C3F" },
  amber: { id: "amber", label: "Amber", seed: "#D98E04" },
  green: { id: "green", label: "Green", seed: "#2F9E44" },
  teal: { id: "teal", label: "Teal", seed: "#0C8599" },
  graphite: { id: "graphite", label: "Graphite", seed: "#4B5563" },
};

/** The one global default accent for new accounts (note 02). */
export const DEFAULT_ACCENT: AccentPresetId = "blue";

/** A stored accent: a preset id or a validated custom sRGB hex (never arbitrary CSS). */
export type AccentChoice = AccentPresetId | `#${string}`;

export function isAccentPresetId(value: unknown): value is AccentPresetId {
  return typeof value === "string" && (accentPresetIds as readonly string[]).includes(value);
}

/**
 * Validates user input for a custom accent. Accepts `#RGB` or `#RRGGBB` (the leading `#` is
 * optional) and returns the normalized uppercase `#RRGGBB`, or null when the value is not a hex color.
 */
export function normalizeCustomAccent(input: string): `#${string}` | null {
  const trimmed = input.trim();
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (!match?.[1]) return null;
  const digits = match[1];
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : digits;
  return `#${full.toUpperCase()}`;
}

export function isAccentChoice(value: unknown): value is AccentChoice {
  return isAccentPresetId(value) || (isHexColor(value) && value === value.toUpperCase());
}

/** The seed hex for a stored accent choice. */
export function accentSeed(choice: AccentChoice): string {
  return isAccentPresetId(choice) ? accentPresets[choice].seed : choice;
}

/** Semantic accent tokens resolved against one theme and mode (§10.3). All values are `#RRGGBB`. */
export interface ResolvedAccent {
  /** Solid fill for markers, checked controls and accent buttons: 3:1 against every surface. */
  readonly accent: string;
  /** Hover state of `accent`, meeting the same checks. */
  readonly accentHover: string;
  /** Text and icons on `accent`: 4.5:1. */
  readonly onAccent: string;
  /** Subtle tint (drop targets, pills, focus glow); body text on it keeps 4.5:1. */
  readonly accentSoft: string;
  /** Selected-row fill; body and muted text on it keep 4.5:1. */
  readonly selection: string;
  /** Focus ring: 3:1 against every surface it is drawn on. */
  readonly focus: string;
  /** Link text: 4.5:1 against every surface, including `selection` and `accentSoft`. */
  readonly link: string;
  /** Action text on the `ink` toast surface (Undo, Try again): 4.5:1. */
  readonly inkLink: string;
  /** Marker and focus color on the top bar and rail chrome: 3:1. */
  readonly chromeAccent: string;
  /** Avatar fill and text on the chrome. */
  readonly chromeAvatarBg: string;
  readonly chromeAvatarFg: string;
  /** True when readability changed the rendered accent away from the seed. */
  readonly adjusted: boolean;
}

interface Requirement {
  readonly against: readonly string[];
  readonly min: number;
}

const LIGHTNESS_STEP = 0.005;

function meets(color: string, requirements: readonly Requirement[]): boolean {
  return requirements.every(({ against, min }) =>
    against.every((background) => contrastRatio(color, background) >= min),
  );
}

/** Whether a set of backdrops is light, so readable foregrounds must be darker. */
function isLightBackdrop(backdrops: readonly string[]): boolean {
  const mean =
    backdrops.reduce((sum, backdrop) => sum + relativeLuminance(backdrop), 0) / backdrops.length;
  // The luminance at which black and white text have equal contrast.
  return mean > 0.1791;
}

/**
 * Walks OKLCH lightness from `startL` in `direction`, keeping hue and (gamut-limited) chroma, and
 * returns the first color that satisfies `accept`; null when none does.
 */
function walkLightness(
  hue: { c: number; h: number },
  startL: number,
  direction: 1 | -1,
  accept: (hex: string) => boolean,
  startColor?: string,
): string | null {
  // Prefer the exact starting color (the seed or the resolved accent) over its OKLCH round trip.
  if (startColor && accept(startColor)) return startColor;
  const steps = Math.ceil(1 / LIGHTNESS_STEP) + 1;
  for (let index = 0; index <= steps; index += 1) {
    const l = startL + direction * index * LIGHTNESS_STEP;
    if (l < 0 || l > 1) {
      const edge = oklchToHex({ l: direction < 0 ? 0 : 1, c: hue.c, h: hue.h });
      return accept(edge) ? edge : null;
    }
    const candidate = oklchToHex({ l, c: hue.c, h: hue.h });
    if (accept(candidate)) return candidate;
  }
  return null;
}

/**
 * A quiet tint of `base` (the theme surface the tint sits on) toward the accent hue, moved back
 * toward `base` until every requirement holds. `base` itself always satisfies the theme's own text
 * contrast, so the walk terminates on a readable color.
 */
function resolveTint(
  base: string,
  hue: { c: number; h: number },
  offset: number,
  chroma: number,
  requirements: readonly Requirement[],
): string {
  const baseL = oklchOf(base).l;
  const targetL = Math.min(1, Math.max(0, baseL + offset));
  const direction: 1 | -1 = offset < 0 ? 1 : -1;
  const tone = { c: Math.min(hue.c, chroma), h: hue.h };
  const steps = Math.ceil(Math.abs(offset) / LIGHTNESS_STEP);
  for (let index = 0; index <= steps; index += 1) {
    const l = targetL + direction * index * LIGHTNESS_STEP;
    const candidate = oklchToHex({ l, c: tone.c, h: tone.h });
    if (meets(candidate, requirements)) return candidate;
  }
  return base.toUpperCase();
}

function darkTone(hue: { c: number; h: number }): string {
  return oklchToHex({ l: 0.19, c: Math.min(hue.c * 0.3, 0.035), h: hue.h });
}

/**
 * Resolves an accent seed into semantic tokens for one theme and mode, preserving the seed's hue
 * where feasible and adjusting lightness (and gamut-limited chroma) until WCAG 2.2 thresholds hold:
 * 4.5:1 for text and 3:1 for UI boundaries, markers and focus indicators (note 02).
 */
export function resolveAccent(
  seed: string,
  theme: ThemeDefinition,
  mode: ColorMode,
): ResolvedAccent {
  if (!isHexColor(seed)) throw new Error("Accent seed must be a #RRGGBB hex color");
  const palette: ThemePalette = renderedPalette(theme, mode);
  const seedOklch = oklchOf(seed);
  const hue = { c: seedOklch.c, h: seedOklch.h };
  const light = mode === "light";
  const textOn = (min: number, colors: readonly string[]): Requirement => ({
    against: colors,
    min,
  });

  const selection = resolveTint(palette.panel, hue, light ? -0.04 : 0.07, light ? 0.03 : 0.04, [
    textOn(TEXT_CONTRAST, [palette.text]),
    textOn(Math.min(TEXT_CONTRAST, contrastRatio(palette.muted, palette.panel)), [palette.muted]),
  ]);
  const accentSoft = resolveTint(
    palette.surface,
    hue,
    light ? -0.055 : 0.06,
    light ? 0.045 : 0.05,
    [textOn(TEXT_CONTRAST, [palette.text])],
  );

  const surfaces = [
    palette.bg,
    palette.panel,
    palette.surface,
    palette.hover,
    palette.codeBg,
    selection,
    accentSoft,
  ];
  const direction: 1 | -1 = light ? -1 : 1;
  const startL = light ? Math.min(seedOklch.l, 0.62) : Math.max(seedOklch.l, 0.74);

  const preferredOnAccent = light ? "#FFFFFF" : darkTone(hue);
  const alternateOnAccent = light ? darkTone(hue) : "#FFFFFF";

  const fillRequirements = (onAccent: string): Requirement[] => [
    { against: surfaces, min: UI_CONTRAST },
    { against: [onAccent], min: TEXT_CONTRAST },
  ];

  let onAccent = preferredOnAccent;
  const seedHex = seed.toUpperCase();
  const startColor = startL === seedOklch.l ? seedHex : undefined;
  let accent = walkLightness(
    hue,
    startL,
    direction,
    (hex) => meets(hex, fillRequirements(preferredOnAccent)),
    startColor,
  );
  if (!accent) {
    onAccent = alternateOnAccent;
    accent = walkLightness(
      hue,
      startL,
      direction,
      (hex) => meets(hex, fillRequirements(alternateOnAccent)),
      startColor,
    );
  }
  if (!accent) {
    // Neutral fallback: the theme's ink pair always reads on its own surfaces.
    accent = palette.ink.toUpperCase();
    onAccent = palette.onInk.toUpperCase();
  }

  const accentL = oklchOf(accent).l;
  const accentHue = { c: oklchOf(accent).c, h: hue.h };
  const hoverCandidates = [0.06, -0.06, 0.03, -0.03].map((delta) =>
    oklchToHex({ l: accentL + direction * delta, c: accentHue.c, h: accentHue.h }),
  );
  const accentHover =
    hoverCandidates.find(
      (candidate) => candidate !== accent && meets(candidate, fillRequirements(onAccent)),
    ) ?? accent;

  const link =
    walkLightness(
      accentHue,
      accentL,
      direction,
      (hex) => meets(hex, [{ against: surfaces, min: TEXT_CONTRAST }]),
      accent,
    ) ?? palette.text.toUpperCase();

  const focus =
    walkLightness(
      accentHue,
      accentL,
      direction,
      (hex) => meets(hex, [{ against: surfaces, min: UI_CONTRAST }]),
      accent,
    ) ?? palette.text.toUpperCase();

  const inkIsLight = isLightBackdrop([palette.ink]);
  const inkLink =
    walkLightness(
      hue,
      inkIsLight ? Math.min(seedOklch.l, 0.5) : Math.max(seedOklch.l, 0.78),
      inkIsLight ? -1 : 1,
      (hex) => meets(hex, [{ against: [palette.ink], min: TEXT_CONTRAST }]),
    ) ?? palette.onInk.toUpperCase();

  const chrome = renderedChrome(theme, mode);
  const chromeSurfaces = [chrome.bg, compositeOver(chrome.hover, chrome.bg)];
  const chromeIsLight = isLightBackdrop(chromeSurfaces);
  const chromeAccent =
    (meets(accent, [{ against: chromeSurfaces, min: UI_CONTRAST }])
      ? accent
      : walkLightness(accentHue, accentL, chromeIsLight ? -1 : 1, (hex) =>
          meets(hex, [{ against: chromeSurfaces, min: UI_CONTRAST }]),
        )) ?? chrome.text.toUpperCase();

  return {
    accent,
    accentHover,
    onAccent,
    accentSoft,
    selection,
    focus,
    link,
    inkLink,
    chromeAccent,
    chromeAvatarBg: chrome.avatar === "accent" ? accent : palette.text.toUpperCase(),
    chromeAvatarFg: chrome.avatar === "accent" ? onAccent : palette.bg.toUpperCase(),
    adjusted: accent !== seedHex,
  };
}
