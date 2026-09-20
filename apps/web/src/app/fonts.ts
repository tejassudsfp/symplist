import localFont from "next/font/local";
import "../theme/fonts.css";

/*
 * Self-hosted theme fonts (§10.3, note 02). Every face comes from a Fontsource package under the SIL
 * Open Font License 1.1; the license notices ship at /licenses/fonts.txt.
 *
 * Each family loads its latin, latin-ext and (where Fontsource ships it) vietnamese subsets as
 * separate `next/font/local` calls, because a call's `declarations` apply to every face in it and
 * each subset needs its own `unicode-range`: the browser then downloads a subset only when the page
 * uses a character in it. Each call defines `--font-<family>-<subset>`, and `theme/fonts.css`
 * composes them into the `--font-<family>` stack that `fontVariable()` in `theme/css.ts` names,
 * with the latin call (and its metric-adjusted fallback) last so the fallback never catches a
 * character an extended subset covers. Only the default theme's latin faces (Studio: Geist and IBM
 * Plex Mono) are preloaded; extended subsets and other themes' faces download on demand. Every
 * value is a literal because next/font requires literal arguments; `fonts.test.ts` checks the
 * files, ranges, preloads and composition against the Fontsource packages.
 */

export const geist = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/geist/files/geist-latin-wght-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-geist-latin",
  display: "swap",
  preload: true,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
  fallback: ["system-ui", "sans-serif"],
});

export const geistLatinExt = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/geist/files/geist-latin-ext-wght-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-geist-latin-ext",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
  adjustFontFallback: false,
});

export const geistVietnamese = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/geist/files/geist-vietnamese-wght-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/geist/files/geist-vietnamese-wght-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-geist-vietnamese",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
    },
  ],
  adjustFontFallback: false,
});

export const sourceSans3 = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2",
      weight: "200 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-italic.woff2",
      weight: "200 900",
      style: "italic",
    },
  ],
  variable: "--font-source-sans-3-latin",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
  fallback: ["system-ui", "sans-serif"],
});

export const sourceSans3LatinExt = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/source-sans-3/files/source-sans-3-latin-ext-wght-normal.woff2",
      weight: "200 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/source-sans-3/files/source-sans-3-latin-ext-wght-italic.woff2",
      weight: "200 900",
      style: "italic",
    },
  ],
  variable: "--font-source-sans-3-latin-ext",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
  adjustFontFallback: false,
});

export const sourceSans3Vietnamese = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/source-sans-3/files/source-sans-3-vietnamese-wght-normal.woff2",
      weight: "200 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/source-sans-3/files/source-sans-3-vietnamese-wght-italic.woff2",
      weight: "200 900",
      style: "italic",
    },
  ],
  variable: "--font-source-sans-3-vietnamese",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
    },
  ],
  adjustFontFallback: false,
});

export const sourceSerif4 = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2",
      weight: "200 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-italic.woff2",
      weight: "200 900",
      style: "italic",
    },
  ],
  variable: "--font-source-serif-4-latin",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
  fallback: ["Georgia", "serif"],
  adjustFontFallback: "Times New Roman",
});

export const sourceSerif4LatinExt = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-ext-wght-normal.woff2",
      weight: "200 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-ext-wght-italic.woff2",
      weight: "200 900",
      style: "italic",
    },
  ],
  variable: "--font-source-serif-4-latin-ext",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
  adjustFontFallback: false,
});

export const sourceSerif4Vietnamese = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-vietnamese-wght-normal.woff2",
      weight: "200 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-vietnamese-wght-italic.woff2",
      weight: "200 900",
      style: "italic",
    },
  ],
  variable: "--font-source-serif-4-vietnamese",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
    },
  ],
  adjustFontFallback: false,
});

export const nunito = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2",
      weight: "200 1000",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/nunito/files/nunito-latin-wght-italic.woff2",
      weight: "200 1000",
      style: "italic",
    },
  ],
  variable: "--font-nunito-latin",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
  fallback: ["system-ui", "sans-serif"],
});

export const nunitoLatinExt = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/nunito/files/nunito-latin-ext-wght-normal.woff2",
      weight: "200 1000",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/nunito/files/nunito-latin-ext-wght-italic.woff2",
      weight: "200 1000",
      style: "italic",
    },
  ],
  variable: "--font-nunito-latin-ext",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
  adjustFontFallback: false,
});

export const nunitoVietnamese = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/nunito/files/nunito-vietnamese-wght-normal.woff2",
      weight: "200 1000",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/nunito/files/nunito-vietnamese-wght-italic.woff2",
      weight: "200 1000",
      style: "italic",
    },
  ],
  variable: "--font-nunito-vietnamese",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
    },
  ],
  adjustFontFallback: false,
});

export const publicSans = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/public-sans/files/public-sans-latin-wght-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/public-sans/files/public-sans-latin-wght-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-public-sans-latin",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
  fallback: ["system-ui", "sans-serif"],
});

export const publicSansLatinExt = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/public-sans/files/public-sans-latin-ext-wght-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/public-sans/files/public-sans-latin-ext-wght-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-public-sans-latin-ext",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
  adjustFontFallback: false,
});

export const publicSansVietnamese = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/public-sans/files/public-sans-vietnamese-wght-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/public-sans/files/public-sans-vietnamese-wght-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-public-sans-vietnamese",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
    },
  ],
  adjustFontFallback: false,
});

export const dmSans = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2",
      weight: "100 1000",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-italic.woff2",
      weight: "100 1000",
      style: "italic",
    },
  ],
  variable: "--font-dm-sans-latin",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
  fallback: ["system-ui", "sans-serif"],
});

export const dmSansLatinExt = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-ext-wght-normal.woff2",
      weight: "100 1000",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-ext-wght-italic.woff2",
      weight: "100 1000",
      style: "italic",
    },
  ],
  variable: "--font-dm-sans-latin-ext",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
  adjustFontFallback: false,
});

export const fraunces = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-opsz-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-opsz-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-fraunces-latin",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
  fallback: ["Georgia", "serif"],
  adjustFontFallback: "Times New Roman",
});

export const frauncesLatinExt = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-ext-opsz-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-ext-opsz-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-fraunces-latin-ext",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
  adjustFontFallback: false,
});

export const frauncesVietnamese = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/fraunces/files/fraunces-vietnamese-opsz-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/fraunces/files/fraunces-vietnamese-opsz-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-fraunces-vietnamese",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
    },
  ],
  adjustFontFallback: false,
});

export const manrope = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2",
      weight: "200 800",
      style: "normal",
    },
  ],
  variable: "--font-manrope-latin",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
  fallback: ["system-ui", "sans-serif"],
});

export const manropeLatinExt = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/manrope/files/manrope-latin-ext-wght-normal.woff2",
      weight: "200 800",
      style: "normal",
    },
  ],
  variable: "--font-manrope-latin-ext",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
  adjustFontFallback: false,
});

export const manropeVietnamese = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/manrope/files/manrope-vietnamese-wght-normal.woff2",
      weight: "200 800",
      style: "normal",
    },
  ],
  variable: "--font-manrope-vietnamese",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
    },
  ],
  adjustFontFallback: false,
});

export const ibmPlexMono = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-italic.woff2",
      weight: "400",
      style: "italic",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
  ],
  variable: "--font-ibm-plex-mono-latin",
  display: "swap",
  preload: true,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
  fallback: ["ui-monospace", "monospace"],
});

export const ibmPlexMonoLatinExt = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-400-italic.woff2",
      weight: "400",
      style: "italic",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
  ],
  variable: "--font-ibm-plex-mono-latin-ext",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
  adjustFontFallback: false,
});

export const ibmPlexMonoVietnamese = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-vietnamese-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-vietnamese-400-italic.woff2",
      weight: "400",
      style: "italic",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-vietnamese-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-vietnamese-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
  ],
  variable: "--font-ibm-plex-mono-vietnamese",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
    },
  ],
  adjustFontFallback: false,
});

/** Class names that define every font subset variable on `<html>`. */
export const fontVariableClassNames = [
  geist,
  geistLatinExt,
  geistVietnamese,
  sourceSans3,
  sourceSans3LatinExt,
  sourceSans3Vietnamese,
  sourceSerif4,
  sourceSerif4LatinExt,
  sourceSerif4Vietnamese,
  nunito,
  nunitoLatinExt,
  nunitoVietnamese,
  publicSans,
  publicSansLatinExt,
  publicSansVietnamese,
  dmSans,
  dmSansLatinExt,
  fraunces,
  frauncesLatinExt,
  frauncesVietnamese,
  manrope,
  manropeLatinExt,
  manropeVietnamese,
  ibmPlexMono,
  ibmPlexMonoLatinExt,
  ibmPlexMonoVietnamese,
]
  .map((font) => font.variable)
  .join(" ");
