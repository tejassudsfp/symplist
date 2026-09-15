import type { CSSProperties } from "react";

/**
 * The single light, high-contrast email design (§12.3, research B2). Colors come from the Studio
 * light palette of the UI sample, darkened where needed so every text and background pair used below
 * reaches at least 4.5:1, which keeps text readable when a client forces its own dark mode. Every
 * block sets an explicit background and color; there are no `dark:` selectors or
 * `prefers-color-scheme` rules.
 */
export const emailColors = {
  page: "#F6F6F4",
  surface: "#FFFFFF",
  line: "#D6D6D1",
  text: "#1A1A1A",
  muted: "#55554F",
  codeBackground: "#F1F1EE",
  accent: "#2A56BF",
  onAccent: "#FFFFFF",
} as const;

/** Text and background pairs the templates render; a test checks each reaches 4.5:1. */
export const emailContrastPairs: ReadonlyArray<
  readonly [foreground: keyof typeof emailColors, background: keyof typeof emailColors]
> = [
  ["text", "surface"],
  ["text", "page"],
  ["text", "codeBackground"],
  ["muted", "surface"],
  ["muted", "page"],
  ["accent", "surface"],
  ["onAccent", "accent"],
];

export const fontStack =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const monoStack =
  "'IBM Plex Mono', SFMono-Regular, Menlo, Consolas, 'Courier New', monospace";

export const styles = {
  body: {
    backgroundColor: emailColors.page,
    color: emailColors.text,
    fontFamily: fontStack,
    margin: "0",
    padding: "24px 12px",
  },
  container: {
    backgroundColor: emailColors.surface,
    color: emailColors.text,
    border: `1px solid ${emailColors.line}`,
    borderRadius: "10px",
    maxWidth: "560px",
    padding: "32px 28px",
  },
  brand: {
    color: emailColors.text,
    fontSize: "15px",
    fontWeight: 600,
    letterSpacing: "-0.01em",
    lineHeight: "20px",
    margin: "0 0 24px",
  },
  heading: {
    color: emailColors.text,
    fontSize: "22px",
    fontWeight: 600,
    lineHeight: "28px",
    margin: "0 0 16px",
  },
  paragraph: {
    color: emailColors.text,
    fontSize: "15px",
    lineHeight: "24px",
    margin: "0 0 16px",
  },
  muted: {
    color: emailColors.muted,
    fontSize: "14px",
    lineHeight: "22px",
    margin: "0 0 12px",
  },
  codeBox: {
    backgroundColor: emailColors.codeBackground,
    color: emailColors.text,
    border: `1px solid ${emailColors.line}`,
    borderRadius: "8px",
    margin: "8px 0 20px",
    padding: "16px 12px",
    textAlign: "center",
  },
  code: {
    color: emailColors.text,
    fontFamily: monoStack,
    fontSize: "32px",
    fontWeight: 600,
    letterSpacing: "0.3em",
    lineHeight: "40px",
    margin: "0",
  },
  detailBox: {
    backgroundColor: emailColors.codeBackground,
    color: emailColors.text,
    border: `1px solid ${emailColors.line}`,
    borderRadius: "8px",
    margin: "0 0 20px",
    padding: "12px 16px",
  },
  detailLabel: {
    color: emailColors.muted,
    fontSize: "12px",
    fontWeight: 600,
    letterSpacing: "0.04em",
    lineHeight: "18px",
    margin: "0",
    textTransform: "uppercase",
  },
  detailValue: {
    color: emailColors.text,
    fontSize: "15px",
    lineHeight: "22px",
    margin: "2px 0 0",
  },
  button: {
    backgroundColor: emailColors.accent,
    border: `1px solid ${emailColors.accent}`,
    borderRadius: "7px",
    boxSizing: "border-box",
    color: emailColors.onAccent,
    display: "inline-block",
    fontSize: "15px",
    fontWeight: 600,
    lineHeight: "20px",
    padding: "12px 20px",
    textDecoration: "none",
  },
  link: {
    color: emailColors.accent,
    textDecoration: "underline",
  },
  rule: {
    border: "none",
    borderTop: `1px solid ${emailColors.line}`,
    margin: "28px 0 20px",
  },
  footer: {
    color: emailColors.muted,
    fontSize: "13px",
    lineHeight: "20px",
    margin: "0 0 8px",
  },
} satisfies Record<string, CSSProperties>;
