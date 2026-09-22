// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio, isHexColor } from "./color.ts";
import {
  chromePalette,
  colorModes,
  DEFAULT_THEME_ID,
  isThemeId,
  type ThemeGeometry,
  type ThemePalette,
  themeIds,
  themes,
} from "./registry.ts";

/**
 * The `THEMES` literal of the original UI sample export, extracted verbatim when `design/` was
 * removed from the repository for the open-source release (c22abfb). The values are byte-identical
 * to the export; only the container changed, so this stays the independent source the registry is
 * checked against rather than a copy of the registry itself.
 */
const samplePath = fileURLToPath(new URL("./__fixtures__/sample-themes.json", import.meta.url));

interface SampleTheme {
  name: string;
  tag: string;
  signature: string;
  font: string;
  headFont: string;
  mono: string;
  light: Record<string, string>;
  dark: Record<string, string>;
  [geometry: string]: unknown;
}

/** Reads the committed UI sample themes. Key order is the sample's own theme order. */
function loadSampleThemes(): Record<string, SampleTheme> {
  return JSON.parse(readFileSync(samplePath, "utf8")) as Record<string, SampleTheme>;
}

const paletteKeys: ReadonlyArray<keyof ThemePalette> = [
  "bg",
  "panel",
  "surface",
  "line",
  "lineStrong",
  "text",
  "muted",
  "faint",
  "hover",
  "selected",
  "codeBg",
  "danger",
  "ok",
  "okSoft",
  "warn",
  "warnSoft",
  "ink",
  "onInk",
];

const geometryKeys: ReadonlyArray<keyof ThemeGeometry> = [
  "r",
  "rl",
  "rc",
  "bubble",
  "rowPad",
  "h2Size",
  "h2Pad",
  "h2Rule",
  "panelInset",
  "panelRadius",
  "panelBorder",
  "panelShadow",
  "sheet",
  "sheetPad",
  "sheetMax",
  "markerW",
  "markerR",
  "markerInset",
  "markerLeft",
  "cardShadow",
  "cardBorder",
];

const familyNames: Record<string, string> = {
  geist: "Geist",
  "source-sans-3": "Source Sans 3",
  "source-serif-4": "Source Serif 4",
  nunito: "Nunito",
  "public-sans": "Public Sans",
  "dm-sans": "DM Sans",
  fraunces: "Fraunces",
  manrope: "Manrope",
  "ibm-plex-mono": "IBM Plex Mono",
};

describe("theme registry", () => {
  const sample = loadSampleThemes();

  it("defines exactly the six themes of the sample, Studio first and default", () => {
    expect([...themeIds]).toEqual(Object.keys(sample));
    expect(DEFAULT_THEME_ID).toBe("studio");
    expect(isThemeId("tide")).toBe(true);
    expect(isThemeId("neon")).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
  });

  it.each(themeIds)("%s copies names, palettes, accents and geometry exactly", (id) => {
    const theme = themes[id];
    const source = sample[id];
    if (!source) throw new Error(`sample has no ${id}`);
    expect(theme.name).toBe(source.name);
    expect(theme.tag).toBe(source.tag);
    expect(theme.signature).toBe(source.signature);
    for (const mode of colorModes) {
      const palette = theme.palettes[mode];
      for (const key of paletteKeys) expect(palette[key], `${mode}.${key}`).toBe(source[mode][key]);
      const accents = theme.sampleAccents[mode];
      expect(accents).toEqual({
        accent: source[mode].accent,
        accentSoft: source[mode].accentSoft,
        onAccent: source[mode].onAccent,
        toastLink: source[mode].toastLink,
        frame: source[mode].frame,
      });
      // Every sample token is accounted for.
      expect(Object.keys(source[mode]).sort()).toEqual(
        [...paletteKeys, "accent", "accentSoft", "onAccent", "toastLink", "frame"].sort(),
      );
    }
    for (const key of geometryKeys) expect(theme.geometry[key], key).toBe(source[key]);
  });

  it.each(themeIds)("%s uses the sample's font families with their fallbacks", (id) => {
    const { fonts } = themes[id];
    const source = sample[id];
    if (!source) throw new Error(`sample has no ${id}`);
    const expectStack = (stack: string, role: (typeof fonts)["ui"]) => {
      expect(stack.replaceAll("'", "")).toBe(`${familyNames[role.family]}, ${role.fallback}`);
    };
    expectStack(source.font, fonts.ui);
    expectStack(source.headFont, fonts.heading);
    expectStack(source.mono, fonts.mono);
  });

  it("carries Tide Light's deep chrome and reuses the page palette elsewhere", () => {
    expect(chromePalette(themes.tide, "light")).toEqual({
      bg: "#0F4B4A",
      line: "#1C5F5D",
      text: "#EAF6F4",
      muted: "#9CC7C2",
      hover: "rgba(255,255,255,.10)",
      avatar: "accent",
    });
    const studio = chromePalette(themes.studio, "dark");
    expect(studio.bg).toBe(themes.studio.palettes.dark.bg);
    expect(studio.avatar).toBe("text");
    expect(chromePalette(themes.tide, "dark").bg).toBe(themes.tide.palettes.dark.bg);
  });

  it.each(themeIds.flatMap((id) => colorModes.map((mode) => ({ id, mode }))))(
    "$id $mode keeps readable body and muted text on its panels",
    ({ id, mode }) => {
      const palette = themes[id].palettes[mode];
      for (const value of Object.values(palette)) expect(isHexColor(value)).toBe(true);
      for (const surface of [palette.bg, palette.panel, palette.surface]) {
        expect(contrastRatio(palette.text, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.onInk, palette.ink)).toBeGreaterThanOrEqual(4.5);
      }
      for (const surface of [palette.panel, palette.surface]) {
        expect(contrastRatio(palette.muted, surface)).toBeGreaterThanOrEqual(4.5);
      }
      const chrome = chromePalette(themes[id], mode);
      expect(contrastRatio(chrome.text, chrome.bg)).toBeGreaterThanOrEqual(4.5);
    },
  );
});
