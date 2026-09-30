"use client";

import { accentPresets, resolveAccent } from "@/theme/accent";
import { fontStack } from "@/theme/css";
import { renderedChrome, renderedPalette } from "@/theme/palette";
import { themeIds, themes } from "@/theme/registry";
import { usePageAppearance } from "./appearance";
import { themeFontLabels } from "./demo-data";

/**
 * Each theme drawn as the app it actually produces: the rail, a task list with one selected row, and
 * the sheet beside it. Pressing one puts the whole page in that theme, which is the only honest way
 * to show an appearance — a picture of a theme is a picture, and this is the thing itself.
 *
 * Three swatches could not carry this. What separates these themes is type, spacing and shape as much
 * as colour — Pebble's round controls and Paper's hairline rules do not survive being reduced to dots.
 * Every value here is read from the live registry at render time rather than written down, so a theme
 * that is retuned is retuned here too, and each card is drawn in the mode the page is currently in.
 *
 * The card is not the appearance stylesheet and cannot be: that is `:root`-scoped and only ever
 * carries the one theme the visitor is using. So these are inline values, which is the honest way to
 * paint six themes on one page.
 */
export function ThemeCards() {
  const { themeId: current, mode, setThemeId } = usePageAppearance();

  return (
    <div className="sym-themes">
      {themeIds.map((id) => {
        const theme = themes[id];
        const c = renderedPalette(theme, mode);
        const chrome = renderedChrome(theme, mode);
        const accent = resolveAccent(accentPresets.blue.seed, theme, mode);
        const g = theme.geometry;
        const active = id === current;
        /*
         * Most themes give the rail the page colour and separate it with a hairline the app draws
         * around it; at 34px wide with no border that column would simply vanish, so it takes the
         * panel tint instead. Tide Light, whose chrome really is a deep field, keeps its own.
         */
        const railBg = chrome.bg === c.bg ? c.panel : chrome.bg;
        const head = { fontFamily: fontStack(theme.fonts.heading) };
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            aria-label={`Use the ${theme.name} theme`}
            className="sym-look-card"
            onClick={() => setThemeId(id)}
          >
            <span aria-hidden="true" className="sym-look-art" style={{ background: c.bg }}>
              <span className="sym-look-rail" style={{ background: railBg, borderRadius: g.rl }}>
                <span style={{ border: `1.5px solid ${chrome.text}` }} />
                <span style={{ background: chrome.muted, opacity: 0.5 }} />
              </span>
              <span
                className="sym-look-list"
                style={{ background: c.panel, border: `1px solid ${c.line}`, borderRadius: g.rl }}
              >
                <span className="sym-look-title" style={{ ...head, color: c.text }}>
                  Now
                </span>
                <span
                  className="sym-look-row"
                  style={{ background: accent.selection, borderRadius: g.r }}
                >
                  <span
                    className="sym-look-box"
                    style={{ border: `1.5px solid ${c.lineStrong}`, background: c.surface }}
                  />
                  <span
                    className="sym-look-bar"
                    style={{ width: "70%", background: c.text, opacity: 0.75 }}
                  />
                  <span className="sym-look-marker" style={{ background: accent.accent }} />
                </span>
                {["52%", "62%"].map((width) => (
                  <span key={width} className="sym-look-row">
                    <span
                      className="sym-look-box"
                      style={{ border: `1.5px solid ${c.lineStrong}` }}
                    />
                    <span
                      className="sym-look-bar"
                      style={{ width, background: c.muted, opacity: 0.6 }}
                    />
                  </span>
                ))}
              </span>
              <span
                className="sym-look-sheet"
                style={{ background: c.surface, border: `1px solid ${c.line}`, borderRadius: g.rl }}
              >
                <span className="sym-look-sheet-title" style={{ ...head, color: c.text }}>
                  Aa
                </span>
                {["90%", "76%", "84%"].map((width) => (
                  <span
                    key={width}
                    className="sym-look-line"
                    style={{ width, background: c.muted }}
                  />
                ))}
                <span
                  className="sym-look-cta"
                  style={{ background: accent.accent, borderRadius: g.r }}
                />
              </span>
            </span>
            <span className="sym-look-foot">
              <span>
                <span className="sym-look-name">{theme.name}</span>
                <span className="sym-look-fonts">{themeFontLabels[id]}</span>
              </span>
              <span className="sym-look-state">{active ? "In use" : "Try it"}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
