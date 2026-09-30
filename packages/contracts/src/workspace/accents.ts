/**
 * The accent palette, shared by appearance settings and label colours.
 *
 * Its own module because both of those need it and they must not import each other: labels reference
 * the palette, the task tree references labels, and appearance settings live beside the task tree — a
 * cycle that resolves to `undefined` at module init rather than to an error you can read.
 */

/** Named accent presets (note 02); a custom appearance accent is an upper-case `#RRGGBB` seed. */
export const appearanceAccentPresets = [
  "blue",
  "violet",
  "rose",
  "coral",
  "amber",
  "green",
  "teal",
  "graphite",
] as const;

export type AppearanceAccentPreset = (typeof appearanceAccentPresets)[number];
