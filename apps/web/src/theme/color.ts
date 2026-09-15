import {
  type Color,
  converter,
  formatHex,
  modeLrgb,
  modeOklab,
  modeOklch,
  modeRgb,
  type Oklch,
  parse,
  type Rgb,
  useMode as registerColorMode,
  toGamut,
  wcagContrast,
  wcagLuminance,
} from "culori/fn";

// Register only the color spaces the accent system needs (tree-shakeable entry). `useMode` is
// culori's mode registry, not a React hook, so it is imported under a descriptive name.
registerColorMode(modeRgb);
registerColorMode(modeLrgb);
registerColorMode(modeOklab);
registerColorMode(modeOklch);

const toRgb = converter("rgb");
const toOklch = converter("oklch");
const mapToSrgb = toGamut("rgb", "oklch");

const hexPattern = /^#[0-9a-f]{6}$/i;

/** Whether a value is a 6-digit sRGB hex such as `#2F5FD0`. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && hexPattern.test(value);
}

function parseOrThrow(color: string): Color {
  const parsed = parse(color);
  if (!parsed) throw new Error(`Unparseable color: ${color}`);
  return parsed;
}

/** Parses a CSS color string (hex or `rgba()`) to sRGB. */
export function rgbOf(color: string): Rgb {
  const rgb = toRgb(parseOrThrow(color));
  return rgb;
}

/** OKLCH coordinates with a defined hue. */
export interface OklchCoordinates {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

/** The OKLCH coordinates of a color; achromatic colors get hue 0. */
export function oklchOf(color: string): OklchCoordinates {
  const value: Oklch = toOklch(parseOrThrow(color));
  return { l: value.l, c: value.c, h: value.h ?? 0 };
}

/** Maps an OKLCH color into sRGB (reducing chroma, keeping lightness and hue) and formats it as hex. */
export function oklchToHex(color: { l: number; c: number; h: number }): string {
  const l = Math.min(1, Math.max(0, color.l));
  const c = Math.max(0, color.c);
  const mapped = mapToSrgb({ mode: "oklch", l, c, h: color.h });
  return formatHex(mapped).toUpperCase();
}

/** Composites a possibly translucent color over an opaque backdrop and returns the opaque hex. */
export function compositeOver(color: string, backdrop: string): string {
  const top = rgbOf(color);
  const bottom = rgbOf(backdrop);
  const alpha = top.alpha ?? 1;
  const mix = (a: number, b: number) => a * alpha + b * (1 - alpha);
  return formatHex({
    mode: "rgb",
    r: mix(top.r, bottom.r),
    g: mix(top.g, bottom.g),
    b: mix(top.b, bottom.b),
  }).toUpperCase();
}

/** WCAG 2 contrast ratio between two opaque colors. */
export function contrastRatio(a: string, b: string): number {
  return wcagContrast(parseOrThrow(a), parseOrThrow(b));
}

/** WCAG 2 relative luminance of an opaque color. */
export function relativeLuminance(color: string): number {
  return wcagLuminance(parseOrThrow(color));
}

/** WCAG 2.2 thresholds: normal text (1.4.3) and UI components and graphics (1.4.11). */
export const TEXT_CONTRAST = 4.5;
export const UI_CONTRAST = 3;
