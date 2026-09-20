/**
 * The versioned theme registry (§10.3, note 02). Palettes and geometry are copied exactly from the
 * user-selected UI sample (`design/UI sample/workspace_now.dc.html`, `THEMES`); a test parses the
 * sample and compares every token. Accent colors are not part of a theme: the sample's accents are
 * kept only as `sampleAccent` for reference, and the rendered accent comes from the user's seed
 * (see `accent.ts`).
 */

export const THEME_REGISTRY_VERSION = 1;

export const themeIds = ["studio", "paper", "pebble", "postcard", "meadow", "tide"] as const;
export type ThemeId = (typeof themeIds)[number];

export const DEFAULT_THEME_ID: ThemeId = "studio";

export const colorModes = ["light", "dark"] as const;
/** A rendered brightness. `system` is a preference that resolves to one of these in CSS. */
export type ColorMode = (typeof colorModes)[number];

/** Neutral surface palette owned by a theme, per mode. Every value is a 6-digit sRGB hex. */
export interface ThemePalette {
  readonly bg: string;
  readonly panel: string;
  readonly surface: string;
  readonly line: string;
  readonly lineStrong: string;
  readonly text: string;
  readonly muted: string;
  readonly faint: string;
  readonly hover: string;
  readonly selected: string;
  readonly codeBg: string;
  readonly danger: string;
  readonly ok: string;
  readonly okSoft: string;
  readonly warn: string;
  readonly warnSoft: string;
  readonly ink: string;
  readonly onInk: string;
}

/** The sample's illustrative accent for this theme and mode; never rendered (accent is a user seed). */
export interface SampleAccent {
  readonly accent: string;
  readonly accentSoft: string;
  readonly onAccent: string;
  readonly toastLink: string;
  readonly frame: string;
}

/** Top bar and icon rail colors. Most themes reuse the page palette; Tide Light has a deep chrome. */
export interface ChromePalette {
  readonly bg: string;
  readonly line: string;
  readonly text: string;
  readonly muted: string;
  /** Hover fill; may be translucent (`rgba(...)`), composited over `bg` for contrast checks. */
  readonly hover: string;
  /** Avatar fill: the theme text color or the resolved accent. */
  readonly avatar: "text" | "accent";
}

/** Theme geometry from the sample (CSS lengths, shadows and flags). */
export interface ThemeGeometry {
  readonly r: string;
  readonly rl: string;
  readonly rc: string;
  readonly bubble: string;
  readonly rowPad: string;
  readonly h2Size: string;
  readonly h2Pad: string;
  readonly h2Rule: boolean;
  readonly panelInset: string;
  readonly panelRadius: string;
  readonly panelBorder: boolean;
  readonly panelShadow: string;
  readonly sheet: boolean;
  readonly sheetPad: string;
  readonly sheetMax: string;
  readonly markerW: string;
  readonly markerR: string;
  readonly markerInset: string;
  readonly markerLeft: string;
  readonly cardShadow: string;
  readonly cardBorder: string;
}

/**
 * Component appearance variants that the sample expresses as per-theme special cases rather than
 * tokens (for example Postcard's 1.5 px sheet outline and its quieter input borders).
 */
export interface ThemeVariants {
  readonly sheetBorderWidth: "1px" | "1.5px";
  readonly sheetShadow: "rule" | "card";
  readonly inputBorder: "lineStrong" | "line";
  readonly titleMotif: "none" | "stamp" | "sprout";
  readonly emptyIllustration: "card" | "page" | "pebbles" | "stamp" | "flower" | "waves";
}

/** Self-hosted font families (see `app/fonts.ts`); each maps to a `next/font/local` CSS variable. */
export const fontFamilyIds = [
  "geist",
  "source-sans-3",
  "source-serif-4",
  "nunito",
  "public-sans",
  "dm-sans",
  "fraunces",
  "manrope",
  "ibm-plex-mono",
] as const;
export type FontFamilyId = (typeof fontFamilyIds)[number];

export interface FontRole {
  readonly family: FontFamilyId;
  /** Fallback stack from the sample, used while the self-hosted face loads or if it fails. */
  readonly fallback: string;
}

export interface ThemeFonts {
  readonly ui: FontRole;
  readonly heading: FontRole;
  readonly mono: FontRole;
}

export interface ThemeDefinition {
  readonly id: ThemeId;
  readonly name: string;
  readonly tag: string;
  readonly signature: string;
  readonly fonts: ThemeFonts;
  readonly geometry: ThemeGeometry;
  readonly variants: ThemeVariants;
  readonly palettes: Readonly<Record<ColorMode, ThemePalette>>;
  readonly sampleAccents: Readonly<Record<ColorMode, SampleAccent>>;
  /** Chrome overrides per mode; modes without an entry reuse the page palette. */
  readonly chrome: Readonly<Partial<Record<ColorMode, ChromePalette>>>;
}

const sans = "system-ui, sans-serif";
const serif = "Georgia, serif";
const monoFallback = "ui-monospace, monospace";
const plexMono: FontRole = { family: "ibm-plex-mono", fallback: monoFallback };

export const themes: Readonly<Record<ThemeId, ThemeDefinition>> = {
  studio: {
    id: "studio",
    name: "Studio",
    tag: "Standard · precise",
    signature:
      "Quiet vertical selection marker, flat continuous surfaces, fine 1 px separators, small crisp controls. No illustration in populated views.",
    fonts: {
      ui: { family: "geist", fallback: sans },
      heading: { family: "geist", fallback: sans },
      mono: plexMono,
    },
    geometry: {
      r: "7px",
      rl: "10px",
      rc: "4px",
      bubble: "12px 12px 4px 12px",
      rowPad: "7px",
      h2Size: "17px",
      h2Pad: "0",
      h2Rule: false,
      panelInset: "0",
      panelRadius: "0",
      panelBorder: false,
      panelShadow: "none",
      sheet: false,
      sheetPad: "0",
      sheetMax: "720px",
      markerW: "2.5px",
      markerR: "2px",
      markerInset: "8px",
      markerLeft: "0",
      cardShadow: "none",
      cardBorder: "1px",
    },
    variants: {
      sheetBorderWidth: "1px",
      sheetShadow: "rule",
      inputBorder: "lineStrong",
      titleMotif: "none",
      emptyIllustration: "card",
    },
    palettes: {
      light: {
        bg: "#F6F6F4",
        panel: "#FBFBFA",
        surface: "#FFFFFF",
        line: "#E6E6E2",
        lineStrong: "#D6D6D1",
        text: "#1A1A1A",
        muted: "#6B6B66",
        faint: "#9A9A95",
        hover: "#ECECE9",
        selected: "#E9EDF7",
        codeBg: "#F1F1EE",
        danger: "#B4382E",
        ok: "#2E7D4F",
        okSoft: "#E9F4EC",
        warn: "#8A5B00",
        warnSoft: "#FBF3DE",
        ink: "#1A1A1A",
        onInk: "#FFFFFF",
      },
      dark: {
        bg: "#1B1B1D",
        panel: "#212124",
        surface: "#29292C",
        line: "#34343A",
        lineStrong: "#48484F",
        text: "#ECECE8",
        muted: "#A6A6A0",
        faint: "#7A7A7E",
        hover: "#2E2E33",
        selected: "#2B334A",
        codeBg: "#232326",
        danger: "#F0908A",
        ok: "#86CBA0",
        okSoft: "#22352A",
        warn: "#E2BE68",
        warnSoft: "#3A3320",
        ink: "#ECECE8",
        onInk: "#1B1B1D",
      },
    },
    sampleAccents: {
      light: {
        accent: "#2F5FD0",
        accentSoft: "#E8EEFB",
        onAccent: "#FFFFFF",
        toastLink: "#9FB8F5",
        frame: "#E4E4E0",
      },
      dark: {
        accent: "#7EA2F2",
        accentSoft: "#2A3552",
        onAccent: "#0F1730",
        toastLink: "#2F5FD0",
        frame: "#101012",
      },
    },
    chrome: {},
  },
  paper: {
    id: "paper",
    name: "Paper",
    tag: "Standard · editorial",
    signature:
      "Serif headings with fine ruled sections, an inset page sheet with generous margins, understated rules instead of shadows. Chat reads like accompanying notes.",
    fonts: {
      ui: { family: "source-sans-3", fallback: sans },
      heading: { family: "source-serif-4", fallback: serif },
      mono: plexMono,
    },
    geometry: {
      r: "4px",
      rl: "6px",
      rc: "3px",
      bubble: "6px",
      rowPad: "8px",
      h2Size: "20px",
      h2Pad: "6px",
      h2Rule: true,
      panelInset: "0",
      panelRadius: "0",
      panelBorder: false,
      panelShadow: "none",
      sheet: true,
      sheetPad: "40px 48px 56px",
      sheetMax: "760px",
      markerW: "2px",
      markerR: "0",
      markerInset: "6px",
      markerLeft: "0",
      cardShadow: "none",
      cardBorder: "1px",
    },
    variants: {
      sheetBorderWidth: "1px",
      sheetShadow: "rule",
      inputBorder: "lineStrong",
      titleMotif: "none",
      emptyIllustration: "page",
    },
    palettes: {
      light: {
        bg: "#EFEAE0",
        panel: "#F4F0E6",
        surface: "#FBF8F1",
        line: "#DDD5C5",
        lineStrong: "#C4B9A3",
        text: "#231F1A",
        muted: "#6E665A",
        faint: "#9B937F",
        hover: "#E9E3D6",
        selected: "#EBE1CE",
        codeBg: "#EEE8DA",
        danger: "#A83A2A",
        ok: "#3B6E3F",
        okSoft: "#E7EEDF",
        warn: "#8A5B00",
        warnSoft: "#F4EAD0",
        ink: "#231F1A",
        onInk: "#FBF8F1",
      },
      dark: {
        bg: "#1F1B17",
        panel: "#26211C",
        surface: "#2E2822",
        line: "#3D362E",
        lineStrong: "#54493D",
        text: "#EDE4D3",
        muted: "#B3A995",
        faint: "#7E7565",
        hover: "#332D26",
        selected: "#3A3129",
        codeBg: "#282320",
        danger: "#EE9B8C",
        ok: "#9CC49A",
        okSoft: "#2D3628",
        warn: "#E3C078",
        warnSoft: "#3C3421",
        ink: "#EDE4D3",
        onInk: "#1F1B17",
      },
    },
    sampleAccents: {
      light: {
        accent: "#8A3B1F",
        accentSoft: "#F1E1D6",
        onAccent: "#FFFFFF",
        toastLink: "#E8B9A4",
        frame: "#DDD6C8",
      },
      dark: {
        accent: "#E0A184",
        accentSoft: "#463229",
        onAccent: "#1F1B17",
        toastLink: "#8A3B1F",
        frame: "#141210",
      },
    },
    chrome: {},
  },
  pebble: {
    id: "pebble",
    name: "Pebble",
    tag: "Quirky · soft",
    signature:
      "Rounded panels floating inside the shell, pill controls, roomier rows, and a small pebble as the selection marker. One two-shape pebble in empty states only.",
    fonts: {
      ui: { family: "nunito", fallback: sans },
      heading: { family: "nunito", fallback: sans },
      mono: plexMono,
    },
    geometry: {
      r: "12px",
      rl: "18px",
      rc: "6px",
      bubble: "16px 16px 6px 16px",
      rowPad: "10px",
      h2Size: "17px",
      h2Pad: "0",
      h2Rule: false,
      panelInset: "10px",
      panelRadius: "18px",
      panelBorder: false,
      panelShadow: "inset 0 1px 0 rgba(255,255,255,.5), 0 1px 3px rgba(30,40,35,.08)",
      sheet: false,
      sheetPad: "0",
      sheetMax: "720px",
      markerW: "7px",
      markerR: "40% 60% 60% 40% / 50% 50% 50% 50%",
      markerInset: "9px",
      markerLeft: "-2px",
      cardShadow: "none",
      cardBorder: "0",
    },
    variants: {
      sheetBorderWidth: "1px",
      sheetShadow: "rule",
      inputBorder: "lineStrong",
      titleMotif: "none",
      emptyIllustration: "pebbles",
    },
    palettes: {
      light: {
        bg: "#E6EAE7",
        panel: "#F3F5F3",
        surface: "#FCFDFC",
        line: "#DCE2DE",
        lineStrong: "#C0CAC4",
        text: "#1F2A25",
        muted: "#5F6E67",
        faint: "#93A09A",
        hover: "#E6EBE8",
        selected: "#DFEAE3",
        codeBg: "#ECF0ED",
        danger: "#B5473B",
        ok: "#3E7D5A",
        okSoft: "#E3F0E8",
        warn: "#946500",
        warnSoft: "#F5EDD3",
        ink: "#1F2A25",
        onInk: "#FFFFFF",
      },
      dark: {
        bg: "#151A18",
        panel: "#1D2421",
        surface: "#262E2A",
        line: "#303936",
        lineStrong: "#465350",
        text: "#E6ECE8",
        muted: "#A3B0A9",
        faint: "#6F7C76",
        hover: "#2A332F",
        selected: "#2B3A32",
        codeBg: "#202724",
        danger: "#F09A8E",
        ok: "#8FCBA6",
        okSoft: "#233329",
        warn: "#E4C270",
        warnSoft: "#3A3520",
        ink: "#E6ECE8",
        onInk: "#151A18",
      },
    },
    sampleAccents: {
      light: {
        accent: "#4F8A6B",
        accentSoft: "#DDEEE4",
        onAccent: "#FFFFFF",
        toastLink: "#A8D9BD",
        frame: "#D6DDD9",
      },
      dark: {
        accent: "#8CC5A6",
        accentSoft: "#28382F",
        onAccent: "#0F1A14",
        toastLink: "#4F8A6B",
        frame: "#0E1211",
      },
    },
    chrome: {},
  },
  postcard: {
    id: "postcard",
    name: "Postcard",
    tag: "Quirky · graphic",
    signature:
      "Stationery feel: soft ink outlines on panels (not on every row), one small offset shadow, cobalt accent with a coral stamp motif. Linework stays consistent, never wobbly.",
    fonts: {
      ui: { family: "public-sans", fallback: sans },
      heading: { family: "public-sans", fallback: sans },
      mono: plexMono,
    },
    geometry: {
      r: "4px",
      rl: "6px",
      rc: "3px",
      bubble: "6px",
      rowPad: "7px",
      h2Size: "17px",
      h2Pad: "0",
      h2Rule: false,
      panelInset: "12px 12px 12px 0",
      panelRadius: "6px",
      panelBorder: true,
      panelShadow: "4px 4px 0 rgba(27,31,46,.10)",
      sheet: true,
      sheetPad: "32px 40px 48px",
      sheetMax: "720px",
      markerW: "4px",
      markerR: "0 3px 3px 0",
      markerInset: "6px",
      markerLeft: "0",
      cardShadow: "3px 3px 0 rgba(27,31,46,.10)",
      cardBorder: "1.5px",
    },
    variants: {
      sheetBorderWidth: "1.5px",
      sheetShadow: "card",
      inputBorder: "line",
      titleMotif: "stamp",
      emptyIllustration: "stamp",
    },
    palettes: {
      light: {
        bg: "#EFEDE6",
        panel: "#FBFAF6",
        surface: "#FFFFFF",
        line: "#D9D6CC",
        lineStrong: "#3A4160",
        text: "#1B1F2E",
        muted: "#5C6172",
        faint: "#8B91A2",
        hover: "#EEEBE2",
        selected: "#E8ECF8",
        codeBg: "#EEEBE3",
        danger: "#B6392C",
        ok: "#2E6F4E",
        okSoft: "#E4F0E8",
        warn: "#8C5A00",
        warnSoft: "#F8EED4",
        ink: "#1B1F2E",
        onInk: "#FFFFFF",
      },
      dark: {
        bg: "#151824",
        panel: "#1D2131",
        surface: "#252A3C",
        line: "#363C55",
        lineStrong: "#8F98BC",
        text: "#ECEEF5",
        muted: "#A9B0C4",
        faint: "#727A91",
        hover: "#2A3042",
        selected: "#2B3352",
        codeBg: "#1B2030",
        danger: "#F49A8C",
        ok: "#8FCBA6",
        okSoft: "#243328",
        warn: "#E5C36F",
        warnSoft: "#3B3521",
        ink: "#ECEEF5",
        onInk: "#151824",
      },
    },
    sampleAccents: {
      light: {
        accent: "#2E4FC4",
        accentSoft: "#E3E9FA",
        onAccent: "#FFFFFF",
        toastLink: "#9FB4F5",
        frame: "#DEDBD2",
      },
      dark: {
        accent: "#8EA6F5",
        accentSoft: "#2A3454",
        onAccent: "#0F1424",
        toastLink: "#2E4FC4",
        frame: "#0D1019",
      },
    },
    chrome: {},
  },
  meadow: {
    id: "meadow",
    name: "Meadow",
    tag: "Quirky · colourful",
    signature:
      "Warm butter-yellow shell with a tomato accent and leaf-green completion; Fraunces headings with a little swash. Colour lives on the shell and markers, the page stays white and calm.",
    fonts: {
      ui: { family: "dm-sans", fallback: sans },
      heading: { family: "fraunces", fallback: serif },
      mono: plexMono,
    },
    geometry: {
      r: "10px",
      rl: "14px",
      rc: "5px",
      bubble: "14px 14px 4px 14px",
      rowPad: "9px",
      h2Size: "19px",
      h2Pad: "0",
      h2Rule: false,
      panelInset: "10px",
      panelRadius: "14px",
      panelBorder: true,
      panelShadow: "0 1px 2px rgba(60,40,20,.06)",
      sheet: true,
      sheetPad: "36px 44px 52px",
      sheetMax: "740px",
      markerW: "4px",
      markerR: "4px",
      markerInset: "8px",
      markerLeft: "0",
      cardShadow: "none",
      cardBorder: "1px",
    },
    variants: {
      sheetBorderWidth: "1px",
      sheetShadow: "rule",
      inputBorder: "lineStrong",
      titleMotif: "sprout",
      emptyIllustration: "flower",
    },
    palettes: {
      light: {
        bg: "#F7E9B8",
        panel: "#FFF8E1",
        surface: "#FFFFFF",
        line: "#EAD9A3",
        lineStrong: "#C9B47A",
        text: "#2A2418",
        muted: "#6E6349",
        faint: "#A39674",
        hover: "#F6ECC9",
        selected: "#FBE3DC",
        codeBg: "#F6EFD8",
        danger: "#B33A2A",
        ok: "#2F7A45",
        okSoft: "#E1F1E4",
        warn: "#8E5A00",
        warnSoft: "#FBEFCF",
        ink: "#2A2418",
        onInk: "#FFF8E1",
      },
      dark: {
        bg: "#23200F",
        panel: "#2B2714",
        surface: "#35301B",
        line: "#443D22",
        lineStrong: "#6B6038",
        text: "#F4ECD6",
        muted: "#BDB18E",
        faint: "#857A5B",
        hover: "#3B351E",
        selected: "#4A2E27",
        codeBg: "#2E2915",
        danger: "#F09A8A",
        ok: "#8FD3A0",
        okSoft: "#263A2A",
        warn: "#E8C46F",
        warnSoft: "#3C3520",
        ink: "#F4ECD6",
        onInk: "#23200F",
      },
    },
    sampleAccents: {
      light: {
        accent: "#D9462B",
        accentSoft: "#FBE3DC",
        onAccent: "#FFFFFF",
        toastLink: "#F6B4A6",
        frame: "#E7D7A1",
      },
      dark: {
        accent: "#F0836B",
        accentSoft: "#4A2E27",
        onAccent: "#23200F",
        toastLink: "#D9462B",
        frame: "#15130A",
      },
    },
    chrome: {},
  },
  tide: {
    id: "tide",
    name: "Tide",
    tag: "Quirky · colourful",
    signature:
      "A deep teal rail and top bar frame a pale aqua workspace; a single tangerine accent for selection and Simon. Dark mode goes full ocean: navy layers, aqua text, warm accent kept.",
    fonts: {
      ui: { family: "manrope", fallback: sans },
      heading: { family: "manrope", fallback: sans },
      mono: plexMono,
    },
    geometry: {
      r: "8px",
      rl: "12px",
      rc: "4px",
      bubble: "12px 12px 4px 12px",
      rowPad: "8px",
      h2Size: "17px",
      h2Pad: "0",
      h2Rule: false,
      panelInset: "0",
      panelRadius: "0",
      panelBorder: false,
      panelShadow: "none",
      sheet: false,
      sheetPad: "0",
      sheetMax: "720px",
      markerW: "3px",
      markerR: "3px",
      markerInset: "8px",
      markerLeft: "0",
      cardShadow: "none",
      cardBorder: "1px",
    },
    variants: {
      sheetBorderWidth: "1px",
      sheetShadow: "rule",
      inputBorder: "lineStrong",
      titleMotif: "none",
      emptyIllustration: "waves",
    },
    palettes: {
      light: {
        bg: "#EEF6F5",
        panel: "#F6FBFA",
        surface: "#FFFFFF",
        line: "#D6E6E3",
        lineStrong: "#A8C4BF",
        text: "#10302E",
        muted: "#4F6F6C",
        faint: "#86A3A0",
        hover: "#E3EFED",
        selected: "#D9EEEA",
        codeBg: "#E8F1F0",
        danger: "#B5403A",
        ok: "#1F7A6E",
        okSoft: "#DDF1ED",
        warn: "#8E5A00",
        warnSoft: "#FBEFD6",
        ink: "#0F4B4A",
        onInk: "#FFFFFF",
      },
      dark: {
        bg: "#0C1A22",
        panel: "#10222B",
        surface: "#162C36",
        line: "#1F3A45",
        lineStrong: "#35586A",
        text: "#E4F1F2",
        muted: "#9EBBC0",
        faint: "#5F7F87",
        hover: "#1B3440",
        selected: "#1F4048",
        codeBg: "#122731",
        danger: "#F49A8C",
        ok: "#7FD1C2",
        okSoft: "#173B37",
        warn: "#E8C46F",
        warnSoft: "#3A3320",
        ink: "#E4F1F2",
        onInk: "#0C1A22",
      },
    },
    sampleAccents: {
      light: {
        accent: "#E8772E",
        accentSoft: "#FDE9DA",
        onAccent: "#FFFFFF",
        toastLink: "#F8C39E",
        frame: "#D7E6E3",
      },
      dark: {
        accent: "#F49A5B",
        accentSoft: "#4A3020",
        onAccent: "#1A1008",
        toastLink: "#E8772E",
        frame: "#06111A",
      },
    },
    // The sample's `deepChrome` for Tide Light: a deep teal top bar and rail.
    chrome: {
      light: {
        bg: "#0F4B4A",
        line: "#1C5F5D",
        text: "#EAF6F4",
        muted: "#9CC7C2",
        hover: "rgba(255,255,255,.10)",
        avatar: "accent",
      },
    },
  },
};

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (themeIds as readonly string[]).includes(value);
}

/** The chrome palette for a theme and mode, falling back to the page palette. */
export function chromePalette(theme: ThemeDefinition, mode: ColorMode): ChromePalette {
  const override = theme.chrome[mode];
  if (override) return override;
  const palette = theme.palettes[mode];
  return {
    bg: palette.bg,
    line: palette.line,
    text: palette.text,
    muted: palette.muted,
    hover: palette.hover,
    avatar: "text",
  };
}
