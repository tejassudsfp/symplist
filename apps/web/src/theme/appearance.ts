import {
  type AccentChoice,
  DEFAULT_ACCENT,
  isAccentChoice,
  isAccentPresetId,
  normalizeCustomAccent,
} from "./accent.ts";
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from "./registry.ts";

export const modePreferences = ["light", "dark", "system"] as const;
/** Light, Dark, or System (follows the device within the chosen theme). */
export type ModePreference = (typeof modePreferences)[number];

/** The three independent appearance preferences (note 02, §10.3 `appearance` group). */
export interface Appearance {
  readonly themeId: ThemeId;
  readonly mode: ModePreference;
  readonly accent: AccentChoice;
}

export const DEFAULT_MODE: ModePreference = "system";

export const DEFAULT_APPEARANCE: Appearance = Object.freeze({
  themeId: DEFAULT_THEME_ID,
  mode: DEFAULT_MODE,
  accent: DEFAULT_ACCENT,
});

/**
 * Non-sensitive display cookie on the web origin (§10.3). It carries only theme id, mode and accent
 * seed so Server Components can render the theme without a flash; it never holds account data.
 */
export const APPEARANCE_COOKIE = "sym_appearance";
export const APPEARANCE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const COOKIE_VERSION = "v1";

export function isModePreference(value: unknown): value is ModePreference {
  return typeof value === "string" && (modePreferences as readonly string[]).includes(value);
}

/**
 * Normalizes untrusted appearance input field by field. An unknown or removed theme falls back to
 * the default theme while keeping the accent and mode (note 02); invalid fields fall back alone.
 */
export function normalizeAppearance(input: {
  readonly themeId?: unknown;
  readonly mode?: unknown;
  readonly accent?: unknown;
}): Appearance {
  const accent: AccentChoice =
    typeof input.accent === "string"
      ? isAccentChoice(input.accent)
        ? input.accent
        : (normalizeCustomAccent(input.accent) ?? DEFAULT_ACCENT)
      : DEFAULT_ACCENT;
  return {
    themeId: isThemeId(input.themeId) ? input.themeId : DEFAULT_THEME_ID,
    mode: isModePreference(input.mode) ? input.mode : DEFAULT_MODE,
    accent,
  };
}

/** Cookie value: `v1.<themeId>.<mode>.<preset id | RRGGBB>`, using only `[a-z0-9.]` characters. */
export function serializeAppearance(appearance: Appearance): string {
  const normalized = normalizeAppearance(appearance);
  const accent = isAccentPresetId(normalized.accent)
    ? normalized.accent
    : normalized.accent.slice(1).toLowerCase();
  return [COOKIE_VERSION, normalized.themeId, normalized.mode, accent].join(".");
}

/** Parses the cookie value; malformed values never throw and fall back per field. */
export function parseAppearanceCookie(raw: string | undefined | null): Appearance {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return DEFAULT_APPEARANCE;
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return DEFAULT_APPEARANCE;
  }
  const [version, themeId, mode, accent, ...rest] = value.split(".");
  if (version !== COOKIE_VERSION || rest.length > 0) return DEFAULT_APPEARANCE;
  const accentValue =
    accent === undefined
      ? undefined
      : isAccentPresetId(accent)
        ? accent
        : /^[0-9a-f]{6}$/i.test(accent)
          ? `#${accent.toUpperCase()}`
          : undefined;
  return normalizeAppearance({ themeId, mode, accent: accentValue });
}
