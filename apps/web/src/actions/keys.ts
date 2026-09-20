import type { Platform } from "./types.ts";

/** Modifier tokens in canonical order. `mod` is Command on macOS and Control elsewhere. */
export const modifierOrder = ["mod", "ctrl", "alt", "shift", "meta"] as const;
export type Modifier = (typeof modifierOrder)[number];

/** One simultaneous key press. */
export interface Chord {
  readonly modifiers: readonly Modifier[];
  readonly key: string;
}

/** A binding: one chord, or a sequence of unmodified chords such as `g` then `c`. */
export interface ParsedBinding {
  readonly steps: readonly Chord[];
  /** Canonical string, for example `mod+shift+k` or `g c`. */
  readonly canonical: string;
}

const namedKeys = new Set([
  "enter",
  "escape",
  "space",
  "tab",
  "backspace",
  "delete",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "home",
  "end",
  "pageup",
  "pagedown",
  "plus",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

/** Printable punctuation keys; Shift is implied by the character, so it is never part of the chord. */
const punctuationKeys = new Set([
  "/",
  "?",
  "[",
  "]",
  ",",
  ".",
  ";",
  "'",
  "`",
  "-",
  "=",
  "\\",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "{",
  "}",
  "|",
  ":",
  '"',
  "<",
  ">",
  "~",
]);

const keyAliases: Readonly<Record<string, string>> = {
  esc: "escape",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  del: "delete",
  " ": "space",
  spacebar: "space",
  "+": "plus",
};

export class BindingSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingSyntaxError";
  }
}

function isLetterOrDigit(key: string): boolean {
  return /^[a-z0-9]$/.test(key);
}

/** Whether a key name is valid in a binding. */
export function isBindableKey(key: string): boolean {
  return isLetterOrDigit(key) || punctuationKeys.has(key) || namedKeys.has(key);
}

export function isPunctuationKey(key: string): boolean {
  return punctuationKeys.has(key);
}

function canonicalChord(chord: Chord): string {
  const modifiers = modifierOrder.filter((modifier) => chord.modifiers.includes(modifier));
  return [...modifiers, chord.key].join("+");
}

/** Whether a chord has no Command, Control, Option/Alt or Meta modifier (Shift alone does not count). */
export function isUnmodified(chord: Chord): boolean {
  return !chord.modifiers.some((modifier) => modifier !== "shift");
}

/** A "single-key shortcut": a sequence, or an unmodified printable key (note 13 toggle). */
export function isSingleKeyBinding(binding: ParsedBinding): boolean {
  if (binding.steps.length > 1) return true;
  const [chord] = binding.steps;
  return chord !== undefined && isUnmodified(chord) && !namedKeys.has(chord.key);
}

function parseChord(token: string): Chord {
  if (token.length === 0) throw new BindingSyntaxError("Empty key");
  // A lone "+" key is written as "plus"; split on "+" only between tokens.
  const parts = token === "+" ? ["plus"] : token.split("+");
  const rawKey = parts.pop();
  if (rawKey === undefined || rawKey === "")
    throw new BindingSyntaxError(`Missing key in "${token}"`);
  const modifiers: Modifier[] = [];
  for (const part of parts) {
    const lowered = part.toLowerCase();
    const modifier = lowered === "cmd" || lowered === "command" ? "mod" : lowered;
    if (!(modifierOrder as readonly string[]).includes(modifier)) {
      throw new BindingSyntaxError(`Unknown modifier "${part}"`);
    }
    if (modifiers.includes(modifier as Modifier)) {
      throw new BindingSyntaxError(`Repeated modifier "${part}"`);
    }
    modifiers.push(modifier as Modifier);
  }
  if (modifiers.includes("mod") && (modifiers.includes("ctrl") || modifiers.includes("meta"))) {
    throw new BindingSyntaxError("Mod already means Command or Control");
  }
  const lowered = rawKey.toLowerCase();
  const key = keyAliases[lowered] ?? lowered;
  if (!isBindableKey(key)) throw new BindingSyntaxError(`Unsupported key "${rawKey}"`);
  if (isPunctuationKey(key) && modifiers.includes("shift")) {
    throw new BindingSyntaxError(`Write the character itself instead of Shift with "${key}"`);
  }
  return { modifiers: modifierOrder.filter((modifier) => modifiers.includes(modifier)), key };
}

/** Parses and canonicalizes a binding string; throws `BindingSyntaxError` when it is invalid. */
export function parseBinding(input: string): ParsedBinding {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new BindingSyntaxError("Empty binding");
  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 3) throw new BindingSyntaxError("Sequences have at most three keys");
  const steps = tokens.map(parseChord);
  if (steps.length > 1) {
    for (const step of steps) {
      if (step.modifiers.length > 0 || !(isLetterOrDigit(step.key) || isPunctuationKey(step.key))) {
        throw new BindingSyntaxError("Sequence steps must be single unmodified keys");
      }
    }
  }
  return { steps, canonical: steps.map(canonicalChord).join(" ") };
}

/** Like `parseBinding`, returning null instead of throwing. */
export function tryParseBinding(input: string): ParsedBinding | null {
  try {
    return parseBinding(input);
  } catch (error) {
    if (error instanceof BindingSyntaxError) return null;
    throw error;
  }
}

export function chordCanonical(chord: Chord): string {
  return canonicalChord(chord);
}

const ignoredEventKeys = new Set([
  "shift",
  "control",
  "alt",
  "altgraph",
  "meta",
  "os",
  "capslock",
  "numlock",
  "scrolllock",
  "fn",
  "fnlock",
  "hyper",
  "super",
  "symbol",
  "symbollock",
  "dead",
  "unidentified",
  "process",
  "compose",
]);

/** The subset of `KeyboardEvent` the dispatcher reads (keeps unit tests independent of the DOM). */
export interface KeyEventLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * Converts a key event to a chord. Letters use `event.code` when Option/Alt changed the character or
 * a non-Latin layout produced it, so bindings keep working on alternate layouts. Returns null for
 * modifier-only presses and composition keys.
 */
export function chordFromEvent(event: KeyEventLike, platform: Platform): Chord | null {
  const rawKey = event.key;
  if (!rawKey) return null;
  const lowered = rawKey.toLowerCase();
  if (ignoredEventKeys.has(lowered)) return null;
  let key = keyAliases[rawKey] ?? keyAliases[lowered] ?? lowered;
  const codeLetter = /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase();
  const codeDigit = /^Digit([0-9])$/.exec(event.code)?.[1];
  const physical = codeLetter ?? codeDigit;
  if (physical && (event.altKey || !isBindableKey(key))) key = physical;
  if (!isBindableKey(key)) return null;
  const modifiers: Modifier[] = [];
  if (platform === "mac") {
    if (event.metaKey) modifiers.push("mod");
    if (event.ctrlKey) modifiers.push("ctrl");
  } else {
    if (event.ctrlKey) modifiers.push("mod");
    if (event.metaKey) modifiers.push("meta");
  }
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey && !isPunctuationKey(key)) modifiers.push("shift");
  return { modifiers: modifierOrder.filter((modifier) => modifiers.includes(modifier)), key };
}

/** Detects macOS and iOS; everything else uses Control for `Mod`. */
export function detectPlatform(
  navigatorLike: { readonly platform?: string; readonly userAgent?: string } | undefined,
): Platform {
  const hint = `${navigatorLike?.platform ?? ""} ${navigatorLike?.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(hint) ? "mac" : "other";
}

export interface KeyCap {
  /** Visual label, for example `⌘` or `Ctrl`. */
  readonly label: string;
  /** Screen-reader text, for example `Command` or `Control`. */
  readonly spoken: string;
}

export interface BindingLabel {
  /** Key caps per step; a sequence has more than one step. */
  readonly steps: readonly (readonly KeyCap[])[];
  /** Compact text, for example `⌘K`, `Ctrl+K` or `G then C`. */
  readonly display: string;
  /** Accessible text equivalent, for example `Command K` or `G, then C`. */
  readonly spoken: string;
}

const modifierCaps: Readonly<Record<Platform, Readonly<Record<Modifier, KeyCap>>>> = {
  mac: {
    mod: { label: "⌘", spoken: "Command" },
    ctrl: { label: "⌃", spoken: "Control" },
    alt: { label: "⌥", spoken: "Option" },
    shift: { label: "⇧", spoken: "Shift" },
    meta: { label: "⌘", spoken: "Command" },
  },
  other: {
    mod: { label: "Ctrl", spoken: "Control" },
    ctrl: { label: "Ctrl", spoken: "Control" },
    alt: { label: "Alt", spoken: "Alt" },
    shift: { label: "Shift", spoken: "Shift" },
    meta: { label: "Meta", spoken: "Meta" },
  },
};

const namedKeyCaps: Readonly<Record<string, { mac: KeyCap; other: KeyCap }>> = {
  enter: { mac: { label: "↩", spoken: "Return" }, other: { label: "Enter", spoken: "Enter" } },
  escape: { mac: { label: "Esc", spoken: "Escape" }, other: { label: "Esc", spoken: "Escape" } },
  space: { mac: { label: "Space", spoken: "Space" }, other: { label: "Space", spoken: "Space" } },
  tab: { mac: { label: "⇥", spoken: "Tab" }, other: { label: "Tab", spoken: "Tab" } },
  backspace: {
    mac: { label: "⌫", spoken: "Delete" },
    other: { label: "Backspace", spoken: "Backspace" },
  },
  delete: {
    mac: { label: "⌦", spoken: "Forward delete" },
    other: { label: "Del", spoken: "Delete" },
  },
  arrowup: { mac: { label: "↑", spoken: "Up arrow" }, other: { label: "↑", spoken: "Up arrow" } },
  arrowdown: {
    mac: { label: "↓", spoken: "Down arrow" },
    other: { label: "↓", spoken: "Down arrow" },
  },
  arrowleft: {
    mac: { label: "←", spoken: "Left arrow" },
    other: { label: "←", spoken: "Left arrow" },
  },
  arrowright: {
    mac: { label: "→", spoken: "Right arrow" },
    other: { label: "→", spoken: "Right arrow" },
  },
  home: { mac: { label: "Home", spoken: "Home" }, other: { label: "Home", spoken: "Home" } },
  end: { mac: { label: "End", spoken: "End" }, other: { label: "End", spoken: "End" } },
  pageup: {
    mac: { label: "PgUp", spoken: "Page up" },
    other: { label: "PgUp", spoken: "Page up" },
  },
  pagedown: {
    mac: { label: "PgDn", spoken: "Page down" },
    other: { label: "PgDn", spoken: "Page down" },
  },
  plus: { mac: { label: "+", spoken: "Plus" }, other: { label: "+", spoken: "Plus" } },
};

const punctuationNames: Readonly<Record<string, string>> = {
  "/": "Slash",
  "?": "Question mark",
  "[": "Left bracket",
  "]": "Right bracket",
  ",": "Comma",
  ".": "Period",
  ";": "Semicolon",
  "'": "Apostrophe",
  "`": "Backtick",
  "-": "Minus",
  "=": "Equals",
  "\\": "Backslash",
};

function keyCap(key: string, platform: Platform): KeyCap {
  const named = namedKeyCaps[key];
  if (named) return named[platform];
  if (/^f\d{1,2}$/.test(key)) return { label: key.toUpperCase(), spoken: key.toUpperCase() };
  if (isPunctuationKey(key)) return { label: key, spoken: punctuationNames[key] ?? key };
  return { label: key.toUpperCase(), spoken: key.toUpperCase() };
}

/** Platform-aware key labels for menus, tooltips and help, never exposing raw event codes (note 13). */
export function formatBinding(binding: ParsedBinding | string, platform: Platform): BindingLabel {
  const parsed = typeof binding === "string" ? parseBinding(binding) : binding;
  const steps = parsed.steps.map((chord) => [
    ...chord.modifiers.map((modifier) => modifierCaps[platform][modifier]),
    keyCap(chord.key, platform),
  ]);
  const stepDisplay = steps.map((caps) =>
    platform === "mac"
      ? caps.map((cap) => cap.label).join("")
      : caps.map((cap) => cap.label).join("+"),
  );
  return {
    steps,
    display: stepDisplay.join(" then "),
    spoken: steps.map((caps) => caps.map((cap) => cap.spoken).join(" ")).join(", then "),
  };
}
