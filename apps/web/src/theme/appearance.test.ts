import { afterEach, describe, expect, it } from "vitest";
import { accentPresets, resolveAccent } from "./accent.ts";
import {
  APPEARANCE_COOKIE,
  type Appearance,
  DEFAULT_APPEARANCE,
  modePreferences,
  normalizeAppearance,
  parseAppearanceCookie,
  serializeAppearance,
} from "./appearance.ts";
import {
  APPEARANCE_STYLE_ELEMENT_ID,
  applyAppearance,
  removeAppearanceCookie,
  resetAppearanceForSignOut,
  writeAppearanceCookie,
} from "./appearance-client.ts";
import { buildAppearanceCss } from "./css.ts";
import { themeIds, themes } from "./registry.ts";

function readCookie(name: string): string | undefined {
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

afterEach(() => {
  removeAppearanceCookie();
  document.getElementById(APPEARANCE_STYLE_ELEMENT_ID)?.remove();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.mode;
});

describe("appearance cookie format", () => {
  it("round-trips every theme, mode and preset", () => {
    for (const themeId of themeIds) {
      for (const mode of modePreferences) {
        for (const accent of Object.keys(accentPresets)) {
          const appearance = { themeId, mode, accent } as Appearance;
          expect(parseAppearanceCookie(serializeAppearance(appearance))).toEqual(appearance);
        }
      }
    }
  });

  it("round-trips a custom hex accent using only cookie-safe characters", () => {
    const appearance: Appearance = { themeId: "paper", mode: "dark", accent: "#C0FFEE" };
    const value = serializeAppearance(appearance);
    expect(value).toBe("v1.paper.dark.c0ffee");
    expect(value).toMatch(/^[a-z0-9.]+$/);
    expect(parseAppearanceCookie(value)).toEqual(appearance);
  });

  it("falls back to the default theme without losing accent and mode when a theme is missing", () => {
    expect(parseAppearanceCookie("v1.neon.dark.rose")).toEqual({
      themeId: "studio",
      mode: "dark",
      accent: "rose",
    });
    expect(parseAppearanceCookie("v1.retired-theme.light.2f5fd0")).toEqual({
      themeId: "studio",
      mode: "light",
      accent: "#2F5FD0",
    });
    expect(normalizeAppearance({ themeId: "gone", mode: "light", accent: "#abcdef" })).toEqual({
      themeId: "studio",
      mode: "light",
      accent: "#ABCDEF",
    });
  });

  it("falls back per field for invalid mode or accent", () => {
    expect(parseAppearanceCookie("v1.tide.sepia.teal")).toEqual({
      themeId: "tide",
      mode: "system",
      accent: "teal",
    });
    expect(parseAppearanceCookie("v1.tide.dark.purple")).toEqual({
      themeId: "tide",
      mode: "dark",
      accent: "blue",
    });
  });

  it.each([
    undefined,
    null,
    "",
    "v2.studio.dark.blue",
    "studio.dark.blue",
    "v1.studio.dark.blue.extra",
    "v1.studio.dark.#fff;background:url(//evil)",
    "v1.studio.dark.ffffff}</style><script>alert(1)</script>",
    "%E0%A4%A",
    "v1.".padEnd(200, "a"),
  ])("never throws and yields safe values for hostile cookie %j", (raw) => {
    const appearance = parseAppearanceCookie(raw);
    expect(themeIds).toContain(appearance.themeId);
    expect(modePreferences).toContain(appearance.mode);
    const css = buildAppearanceCss(appearance);
    expect(css).not.toMatch(/<|url\(|script/i);
  });

  it("defaults to Studio, System and the Blue preset", () => {
    expect(DEFAULT_APPEARANCE).toEqual({ themeId: "studio", mode: "system", accent: "blue" });
  });
});

describe("appearance stylesheet", () => {
  it("emits both palettes, the resolved accent tokens and system mode via prefers-color-scheme", () => {
    const css = buildAppearanceCss({ themeId: "pebble", mode: "system", accent: "violet" });
    const light = resolveAccent(accentPresets.violet.seed, themes.pebble, "light");
    const dark = resolveAccent(accentPresets.violet.seed, themes.pebble, "dark");
    expect(css).toContain(
      `:root[data-theme="pebble"][data-mode="light"],:root[data-theme="pebble"][data-mode="system"]{color-scheme:light;`,
    );
    expect(css).toContain(`:root[data-theme="pebble"][data-mode="dark"]{color-scheme:dark;`);
    expect(css).toContain(
      `@media (prefers-color-scheme: dark){:root[data-theme="pebble"][data-mode="system"]{color-scheme:dark;`,
    );
    expect(css).toContain(`--sym-accent:${light.accent};`);
    expect(css).toContain(`--sym-accent:${dark.accent};`);
    expect(css).toContain(`--sym-selection:${light.selection};`);
    expect(css).toContain(`--sym-bg:${themes.pebble.palettes.light.bg};`);
    expect(css).toContain(`--sym-bg:${themes.pebble.palettes.dark.bg};`);
    expect(css).toContain(`--sym-marker-r:${themes.pebble.geometry.markerR};`);
    expect(css).toContain("--sym-font:var(--font-nunito), system-ui, sans-serif;");
    expect(css).not.toContain("adjusted");
  });

  it("maps per-theme variants such as Postcard's sheet outline and quieter input border", () => {
    const css = buildAppearanceCss({ themeId: "postcard", mode: "light", accent: "blue" });
    expect(css).toContain("--sym-sheet-border:1.5px solid var(--sym-line);");
    expect(css).toContain(`--sym-sheet-shadow:${themes.postcard.geometry.cardShadow};`);
    expect(css).toContain("--sym-input-border:var(--sym-line);");
    const studio = buildAppearanceCss({ themeId: "studio", mode: "light", accent: "blue" });
    expect(studio).toContain("--sym-sheet-border:0;");
    expect(studio).toContain("--sym-sheet-bg:transparent;");
  });

  it("uses Tide Light's deep chrome only in light mode", () => {
    const css = buildAppearanceCss({ themeId: "tide", mode: "light", accent: "blue" });
    expect(css).toContain("--sym-chrome-bg:#0F4B4A;");
    expect(css).toContain(`--sym-chrome-bg:${themes.tide.palettes.dark.bg};`);
  });
});

describe("appearance client helper", () => {
  it("writes and removes the sym_appearance cookie", () => {
    writeAppearanceCookie({ themeId: "meadow", mode: "dark", accent: "#123ABC" });
    expect(readCookie(APPEARANCE_COOKIE)).toBe("v1.meadow.dark.123abc");
    removeAppearanceCookie();
    expect(readCookie(APPEARANCE_COOKIE)).toBeUndefined();
  });

  it("applies an appearance in place: stylesheet, attributes and cookie", () => {
    const style = document.createElement("style");
    style.id = APPEARANCE_STYLE_ELEMENT_ID;
    document.head.append(style);
    const applied = applyAppearance({ themeId: "paper", mode: "light", accent: "green" });
    expect(document.getElementById(APPEARANCE_STYLE_ELEMENT_ID)).toBe(style);
    expect(style.textContent).toContain(':root[data-theme="paper"]');
    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(document.documentElement.dataset.mode).toBe("light");
    expect(readCookie(APPEARANCE_COOKIE)).toBe(serializeAppearance(applied));
  });

  it("previews without persisting and never trusts unvalidated input", () => {
    applyAppearance({ themeId: "nope", mode: "dark", accent: "#fff" } as unknown as Appearance, {
      persist: false,
    });
    expect(document.documentElement.dataset.theme).toBe("studio");
    expect(document.documentElement.dataset.mode).toBe("dark");
    expect(readCookie(APPEARANCE_COOKIE)).toBeUndefined();
    const style = document.getElementById(APPEARANCE_STYLE_ELEMENT_ID);
    expect(style?.textContent).toContain(`--sym-bg:${themes.studio.palettes.dark.bg};`);
  });

  it("clears display state on sign-out", () => {
    applyAppearance({ themeId: "tide", mode: "dark", accent: "coral" });
    resetAppearanceForSignOut();
    expect(readCookie(APPEARANCE_COOKIE)).toBeUndefined();
    expect(document.documentElement.dataset.theme).toBe("studio");
    expect(document.documentElement.dataset.mode).toBe("system");
  });
});
