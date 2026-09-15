import { describe, expect, it } from "vitest";
import {
  type AccentChoice,
  accentPresetIds,
  accentPresets,
  accentSeed,
  isAccentChoice,
  normalizeCustomAccent,
  type ResolvedAccent,
  resolveAccent,
} from "./accent.ts";
import { compositeOver, contrastRatio, isHexColor, oklchOf } from "./color.ts";
import { renderedChrome, renderedPalette } from "./palette.ts";
import { type ColorMode, colorModes, type ThemeDefinition, themeIds, themes } from "./registry.ts";

/** Extreme custom seeds called out in the themes brief, plus saturated primaries and greys. */
const extremeSeeds = [
  "#FFFFFF",
  "#FAFAFA",
  "#F5F5F0",
  "#000000",
  "#050505",
  "#111111",
  "#FFFF00",
  "#FFEA00",
  "#F0FF3A",
  "#00FFFF",
  "#FF00FF",
  "#00FF00",
  "#FF0000",
  "#0000FF",
  "#808080",
  "#7F7F7F",
] as const;

function assertReadable(resolved: ResolvedAccent, theme: ThemeDefinition, mode: ColorMode) {
  const palette = renderedPalette(theme, mode);
  const surfaces = [
    palette.bg,
    palette.panel,
    palette.surface,
    palette.hover,
    palette.codeBg,
    resolved.selection,
    resolved.accentSoft,
  ];
  const failures: string[] = [];
  const check = (label: string, fg: string, bg: string, min: number) => {
    const ratio = contrastRatio(fg, bg);
    if (ratio < min) failures.push(`${label} ${fg} on ${bg} = ${ratio.toFixed(2)} < ${min}`);
  };
  for (const surface of surfaces) {
    check("accent (UI)", resolved.accent, surface, 3);
    check("accentHover (UI)", resolved.accentHover, surface, 3);
    check("focus (UI)", resolved.focus, surface, 3);
    check("link (text)", resolved.link, surface, 4.5);
  }
  check("onAccent (text)", resolved.onAccent, resolved.accent, 4.5);
  check("onAccent on hover (text)", resolved.onAccent, resolved.accentHover, 4.5);
  check("text on selection", palette.text, resolved.selection, 4.5);
  check("muted on selection", palette.muted, resolved.selection, 4.5);
  check("text on accentSoft", palette.text, resolved.accentSoft, 4.5);
  check("inkLink on ink", resolved.inkLink, palette.ink, 4.5);
  const chrome = renderedChrome(theme, mode);
  check("chromeAccent on chrome", resolved.chromeAccent, chrome.bg, 3);
  check(
    "chromeAccent on chrome hover",
    resolved.chromeAccent,
    compositeOver(chrome.hover, chrome.bg),
    3,
  );
  check("chrome avatar text", resolved.chromeAvatarFg, resolved.chromeAvatarBg, 4.5);
  for (const value of Object.values(resolved)) {
    if (typeof value === "string" && !isHexColor(value)) failures.push(`not hex: ${value}`);
  }
  return failures;
}

describe("accent presets", () => {
  it("offers exactly the eight named presets from note 02", () => {
    expect(accentPresetIds.map((id) => accentPresets[id].label)).toEqual([
      "Blue",
      "Violet",
      "Rose",
      "Coral",
      "Amber",
      "Green",
      "Teal",
      "Graphite",
    ]);
    for (const id of accentPresetIds) expect(isHexColor(accentPresets[id].seed)).toBe(true);
  });
});

describe("custom accent validation", () => {
  it.each([
    ["#2f5fd0", "#2F5FD0"],
    ["2F5FD0", "#2F5FD0"],
    ["  #abc ", "#AABBCC"],
    ["fff", "#FFFFFF"],
  ])("normalizes %j to %s", (input, expected) => {
    expect(normalizeCustomAccent(input)).toBe(expected);
  });

  it.each([
    "",
    "#",
    "#12345",
    "#1234567",
    "#GGGGGG",
    "red",
    "rgb(0,0,0)",
    "var(--x)",
    "#fff;background:url(x)",
    "#FFFFFF}</style><script>",
    "expression(alert(1))",
  ])("rejects %j", (input) => {
    expect(normalizeCustomAccent(input)).toBeNull();
  });

  it("accepts only presets and normalized uppercase hex as stored choices", () => {
    expect(isAccentChoice("blue")).toBe(true);
    expect(isAccentChoice("#2F5FD0")).toBe(true);
    expect(isAccentChoice("#2f5fd0")).toBe(false);
    expect(isAccentChoice("purple")).toBe(false);
    expect(isAccentChoice("#FFF")).toBe(false);
    expect(isAccentChoice(42)).toBe(false);
  });

  it("resolves the seed of a choice", () => {
    expect(accentSeed("teal")).toBe(accentPresets.teal.seed);
    expect(accentSeed("#123456" as AccentChoice)).toBe("#123456");
  });

  it("refuses to resolve anything but a hex seed", () => {
    expect(() => resolveAccent("red", themes.studio, "light")).toThrow();
  });
});

describe("resolved accents meet WCAG 2.2 contrast", () => {
  const cases = themeIds.flatMap((themeId) =>
    colorModes.flatMap((mode) => [
      ...accentPresetIds.map((preset) => ({
        themeId,
        mode,
        label: preset,
        seed: accentPresets[preset].seed,
      })),
      ...extremeSeeds.map((seed) => ({ themeId, mode, label: seed, seed })),
      // The sample's own illustrative accents (Tide's tangerine fails 3:1 on white as drawn).
      ...colorModes.map((sampleMode) => ({
        themeId,
        mode,
        label: `sample ${sampleMode}`,
        seed: themes[themeId].sampleAccents[sampleMode].accent,
      })),
    ]),
  );

  it.each(cases)("$themeId $mode with $label", ({ themeId, mode, seed }) => {
    const theme = themes[themeId];
    const resolved = resolveAccent(seed, theme, mode);
    expect(assertReadable(resolved, theme, mode)).toEqual([]);
  });

  it("keeps a seed that already meets every threshold unchanged", () => {
    const resolved = resolveAccent("#2F5FD0", themes.studio, "light");
    expect(resolved.accent).toBe("#2F5FD0");
    expect(resolved.adjusted).toBe(false);
  });

  it("preserves the chosen hue while adjusting lightness", () => {
    for (const mode of colorModes) {
      const resolved = resolveAccent(accentPresets.rose.seed, themes.pebble, mode);
      const seedHue = oklchOf(accentPresets.rose.seed).h;
      const hue = oklchOf(resolved.accent).h;
      expect(Math.abs(hue - seedHue)).toBeLessThan(6);
    }
  });

  it("flags bright yellow as adjusted in light mode and renders a darker, readable shade", () => {
    const resolved = resolveAccent("#FFFF00", themes.studio, "light");
    expect(resolved.adjusted).toBe(true);
    expect(oklchOf(resolved.accent).l).toBeLessThan(oklchOf("#FFFF00").l);
  });

  it("lightens near-black for dark mode", () => {
    const resolved = resolveAccent("#050505", themes.postcard, "dark");
    expect(resolved.adjusted).toBe(true);
    expect(oklchOf(resolved.accent).l).toBeGreaterThan(0.6);
  });

  it("uses a separate chrome accent where Tide Light's deep teal chrome needs one", () => {
    const resolved = resolveAccent(accentPresets.blue.seed, themes.tide, "light");
    expect(resolved.chromeAccent).not.toBe(resolved.accent);
    expect(resolved.chromeAvatarBg).toBe(resolved.accent);
    expect(resolved.chromeAvatarFg).toBe(resolved.onAccent);
  });

  it("keeps the theme text avatar on chromes that reuse the page palette", () => {
    const resolved = resolveAccent(accentPresets.blue.seed, themes.studio, "dark");
    expect(resolved.chromeAvatarBg).toBe(themes.studio.palettes.dark.text.toUpperCase());
    expect(resolved.chromeAccent).toBe(resolved.accent);
  });
});
