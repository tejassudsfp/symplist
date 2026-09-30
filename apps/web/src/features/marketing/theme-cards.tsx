import { accentPresets, resolveAccent } from "@/theme/accent";
import { fontStack } from "@/theme/css";
import { renderedChrome, renderedPalette } from "@/theme/palette";
import { type ColorMode, type ThemeId, themeIds, themes } from "@/theme/registry";

/**
 * Each theme drawn as the app it actually produces: the rail, a task list with one selected row, and
 * the sheet beside it.
 *
 * Three swatches could not carry this. What separates these themes is type, spacing and shape as much
 * as colour — Pebble's round controls and Paper's hairline rules do not survive being reduced to dots.
 * Every value here is read from the live registry at render time rather than written down, so a theme
 * that is retuned is retuned here too.
 *
 * The card is not the appearance stylesheet and cannot be: that is `:root`-scoped and only ever
 * carries the one theme the visitor is using. So these are inline values, which is the honest way to
 * paint six themes on one page.
 */

/**
 * The typeface pairing each theme is built on, as the mockup names it. The registry stores font keys
 * rather than a label, and a key is not a thing to show a stranger.
 */
const fontLabels: Readonly<Record<ThemeId, string>> = {
  studio: "Geist · IBM Plex Mono",
  paper: "Source Serif 4 · Source Sans 3",
  pebble: "Nunito",
  postcard: "Public Sans · IBM Plex Mono",
  meadow: "Fraunces · DM Sans",
  tide: "Manrope · IBM Plex Mono",
};

export function ThemeCards({ mode }: { readonly mode: ColorMode }) {
  return (
    <ul className="sym-themes">
      {themeIds.map((id) => {
        const theme = themes[id];
        const c = renderedPalette(theme, mode);
        const chrome = renderedChrome(theme, mode);
        const accent = resolveAccent(accentPresets.blue.seed, theme, mode);
        const g = theme.geometry;
        const head = { fontFamily: fontStack(theme.fonts.heading) };
        return (
          <li key={id} className="sym-theme-card">
            <div
              aria-hidden="true"
              className="sym-theme-card-art"
              style={{ background: c.bg, borderRadius: 0 }}
            >
              <div
                className="sym-theme-card-rail"
                style={{ background: chrome.bg, borderRadius: g.rl }}
              >
                <span style={{ border: `1.5px solid ${chrome.text}` }} />
                <span style={{ background: chrome.muted, opacity: 0.5 }} />
              </div>
              <div
                className="sym-theme-card-list"
                style={{ background: c.panel, border: `1px solid ${c.line}`, borderRadius: g.rl }}
              >
                <span className="sym-theme-card-title" style={{ ...head, color: c.text }}>
                  Now
                </span>
                <span
                  className="sym-theme-card-row"
                  style={{ background: c.selected, borderRadius: g.r }}
                >
                  <span
                    className="sym-theme-card-box"
                    style={{ border: `1.5px solid ${c.lineStrong}`, background: c.surface }}
                  />
                  <span
                    className="sym-theme-card-bar"
                    style={{ width: "70%", background: c.text, opacity: 0.75 }}
                  />
                  <span className="sym-theme-card-marker" style={{ background: accent.accent }} />
                </span>
                {["52%", "62%"].map((width) => (
                  <span key={width} className="sym-theme-card-row">
                    <span
                      className="sym-theme-card-box"
                      style={{ border: `1.5px solid ${c.lineStrong}` }}
                    />
                    <span
                      className="sym-theme-card-bar"
                      style={{ width, background: c.muted, opacity: 0.6 }}
                    />
                  </span>
                ))}
              </div>
              <div
                className="sym-theme-card-sheet"
                style={{ background: c.surface, border: `1px solid ${c.line}`, borderRadius: g.rl }}
              >
                <span className="sym-theme-card-sheet-title" style={{ ...head, color: c.text }}>
                  A page
                </span>
                {["90%", "76%", "84%"].map((width) => (
                  <span
                    key={width}
                    className="sym-theme-card-line"
                    style={{ width, background: c.muted }}
                  />
                ))}
                <span
                  className="sym-theme-card-cta"
                  style={{ background: accent.accent, borderRadius: g.r }}
                />
              </div>
            </div>
            <div className="sym-theme-card-foot">
              <div>
                <div className="sym-theme-card-name">{theme.name}</div>
                <div className="sym-theme-card-fonts">{fontLabels[id]}</div>
              </div>
              <span className="sym-theme-card-state" style={{ color: accent.accent }}>
                {theme.tag}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
