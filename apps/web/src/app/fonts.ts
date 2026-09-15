import localFont from "next/font/local";

/*
 * Self-hosted theme fonts (§10.3, note 02). Every face comes from a Fontsource package under the SIL
 * Open Font License 1.1; the license notices ship at /licenses/fonts.txt. Only the default theme's
 * faces (Studio: Geist and IBM Plex Mono) are preloaded; the others download when a theme uses them.
 * `variable` names follow `fontVariable()` in `theme/css.ts`.
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
  variable: "--font-geist",
  display: "swap",
  preload: true,
  fallback: ["system-ui", "sans-serif"],
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
  variable: "--font-source-sans-3",
  display: "swap",
  preload: false,
  fallback: ["system-ui", "sans-serif"],
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
  variable: "--font-source-serif-4",
  display: "swap",
  preload: false,
  fallback: ["Georgia", "serif"],
  adjustFontFallback: "Times New Roman",
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
  variable: "--font-nunito",
  display: "swap",
  preload: false,
  fallback: ["system-ui", "sans-serif"],
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
  variable: "--font-public-sans",
  display: "swap",
  preload: false,
  fallback: ["system-ui", "sans-serif"],
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
  variable: "--font-dm-sans",
  display: "swap",
  preload: false,
  fallback: ["system-ui", "sans-serif"],
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
  variable: "--font-fraunces",
  display: "swap",
  preload: false,
  fallback: ["Georgia", "serif"],
  adjustFontFallback: "Times New Roman",
});

export const manrope = localFont({
  src: "../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2",
  weight: "200 800",
  style: "normal",
  variable: "--font-manrope",
  display: "swap",
  preload: false,
  fallback: ["system-ui", "sans-serif"],
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
  variable: "--font-ibm-plex-mono",
  display: "swap",
  preload: true,
  fallback: ["ui-monospace", "monospace"],
});

/** Class names that define every font variable on `<html>`. */
export const fontVariableClassNames = [
  geist,
  sourceSans3,
  sourceSerif4,
  nunito,
  publicSans,
  dmSans,
  fraunces,
  manrope,
  ibmPlexMono,
]
  .map((font) => font.variable)
  .join(" ");
