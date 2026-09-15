import { describe, expect, it } from "vitest";
import { compositeOver, contrastRatio, oklchOf } from "./color.ts";
import { renderedChrome, renderedPalette } from "./palette.ts";
import { chromePalette, colorModes, themeIds, themes } from "./registry.ts";

const cases = themeIds.flatMap((id) => colorModes.map((mode) => ({ id, mode })));

describe("rendered palettes", () => {
  it.each(cases)("$id $mode renders muted text at 4.5:1 on every surface", ({ id, mode }) => {
    const palette = renderedPalette(themes[id], mode);
    for (const surface of [
      palette.bg,
      palette.panel,
      palette.surface,
      palette.hover,
      palette.codeBg,
    ]) {
      expect(contrastRatio(palette.muted, surface)).toBeGreaterThanOrEqual(4.5);
    }
    const chrome = renderedChrome(themes[id], mode);
    expect(contrastRatio(chrome.muted, chrome.bg)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(chrome.muted, compositeOver(chrome.hover, chrome.bg)),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(chrome.text, compositeOver(chrome.hover, chrome.bg)),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(cases)("$id $mode changes nothing but muted text", ({ id, mode }) => {
    const source = themes[id].palettes[mode];
    const rendered = renderedPalette(themes[id], mode);
    expect({ ...rendered, muted: source.muted }).toEqual(source);
    const hue = (color: string) => oklchOf(color).h;
    if (rendered.muted !== source.muted) {
      expect(Math.abs(hue(rendered.muted) - hue(source.muted))).toBeLessThan(8);
      expect(contrastRatio(rendered.muted, source.text)).toBeGreaterThan(1.5);
    }
  });

  it("keeps the sample's value wherever it already meets the threshold", () => {
    expect(renderedPalette(themes.studio, "light").muted).toBe(themes.studio.palettes.light.muted);
    expect(renderedPalette(themes.tide, "dark").muted).toBe(themes.tide.palettes.dark.muted);
  });

  it("adjusts the sample values that fall short (Pebble Light on its page, Paper Light on hover)", () => {
    const pebble = themes.pebble.palettes.light;
    expect(contrastRatio(pebble.muted, pebble.bg)).toBeLessThan(4.5);
    expect(renderedPalette(themes.pebble, "light").muted).not.toBe(pebble.muted);
    const paper = themes.paper.palettes.light;
    expect(contrastRatio(paper.muted, paper.hover)).toBeLessThan(4.5);
    expect(renderedPalette(themes.paper, "light").muted).not.toBe(paper.muted);
  });

  it("keeps Tide Light's deep chrome colors", () => {
    const chrome = renderedChrome(themes.tide, "light");
    expect(chrome.bg).toBe(chromePalette(themes.tide, "light").bg);
    expect(chrome.text).toBe(chromePalette(themes.tide, "light").text);
  });
});
