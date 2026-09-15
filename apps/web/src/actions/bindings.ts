import {
  BindingSyntaxError,
  chordCanonical,
  isSingleKeyBinding,
  type ParsedBinding,
  parseBinding,
  tryParseBinding,
} from "./keys.ts";
import type { AppAction, Platform } from "./types.ts";

/**
 * The `keyboard` preference group (§10.2, §10.3): per-action remaps (`null` unbinds) and the
 * Disable single-key shortcuts toggle.
 */
export interface KeyboardPreferences {
  readonly overrides: Readonly<Record<string, string | null>>;
  readonly singleKeyShortcuts: boolean;
}

export const DEFAULT_KEYBOARD_PREFERENCES: KeyboardPreferences = Object.freeze({
  overrides: Object.freeze({}),
  singleKeyShortcuts: true,
});

/**
 * Browser and operating-system controls a remap may never take (note 13): tab and window switching,
 * address bar, reload, history, clipboard and undo, zoom, print, developer tools and dismissal.
 */
const reservedCommon = [
  "tab",
  "shift+tab",
  "escape",
  "mod+t",
  "mod+shift+t",
  "mod+w",
  "mod+shift+w",
  "mod+n",
  "mod+shift+n",
  "mod+l",
  "mod+r",
  "mod+shift+r",
  "mod+p",
  "mod+d",
  "mod+j",
  "mod+o",
  "mod+k",
  "mod+s",
  "mod+c",
  "mod+v",
  "mod+x",
  "mod+a",
  "mod+z",
  "mod+shift+z",
  "mod+y",
  "mod+plus",
  "mod+=",
  "mod+-",
  "mod+0",
  "mod+shift+i",
  "mod+shift+j",
  "mod+shift+c",
  "mod+shift+delete",
  "f5",
  "f11",
  "f12",
  "alt+arrowleft",
  "alt+arrowright",
  "mod+tab",
  "mod+shift+tab",
  ...Array.from({ length: 9 }, (_, index) => `mod+${index + 1}`),
] as const;

const reservedByPlatform: Readonly<Record<Platform, readonly string[]>> = {
  mac: [
    "mod+q",
    "mod+h",
    "mod+alt+h",
    "mod+m",
    "mod+,",
    "mod+`",
    "mod+[",
    "mod+]",
    "mod+space",
    "ctrl+space",
    "mod+alt+i",
    "mod+alt+j",
    "mod+shift+3",
    "mod+shift+4",
    "mod+shift+5",
    "ctrl+arrowleft",
    "ctrl+arrowright",
    "ctrl+arrowup",
    "ctrl+arrowdown",
  ],
  other: ["alt+f4", "mod+h", "mod+e", "mod+f4", "alt+home", "mod+shift+b", "meta+d", "meta+l"],
};

/**
 * `mod+s` and `mod+k` are Symplist defaults (save, palette) that browsers also use. They are reserved
 * against remapping other actions onto them, but actions that already own them by default keep them.
 */
export function isReservedBinding(canonical: string, platform: Platform): boolean {
  return (
    (reservedCommon as readonly string[]).includes(canonical) ||
    reservedByPlatform[platform].includes(canonical)
  );
}

/** The binding each action currently uses: its default unless overridden; null when unbound. */
export function effectiveBindings(
  actions: readonly AppAction[],
  preferences: KeyboardPreferences,
): ReadonlyMap<string, ParsedBinding | null> {
  const bindings = new Map<string, ParsedBinding | null>();
  for (const action of actions) {
    const override = Object.hasOwn(preferences.overrides, action.id)
      ? preferences.overrides[action.id]
      : undefined;
    const source = override === undefined ? action.defaultBinding : override;
    bindings.set(action.id, source ? tryParseBinding(source) : null);
  }
  return bindings;
}

/** Whether two actions can both be active for the same key press. */
export function contextsOverlap(a: AppAction, b: AppAction): boolean {
  const layered = (action: AppAction) => action.context === "modal" || action.context === "menu";
  if (a.context === b.context) {
    if (a.context !== "pane") return true;
    return a.pane === undefined || b.pane === undefined || a.pane === b.pane;
  }
  // App actions stay active under editors, composers and panes (lower precedence), but never under
  // a modal or menu layer, which blocks everything beneath it.
  if (a.context === "app") return !layered(b);
  if (b.context === "app") return !layered(a);
  return false;
}

/** Equal bindings, or one binding being a prefix of the other's sequence (`g` versus `g c`). */
export function bindingsCollide(a: ParsedBinding, b: ParsedBinding): boolean {
  const length = Math.min(a.steps.length, b.steps.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.steps[index];
    const right = b.steps[index];
    if (!left || !right || chordCanonical(left) !== chordCanonical(right)) return false;
  }
  return true;
}

export interface BindingConflict {
  readonly actionIds: readonly [string, string];
  readonly binding: string;
}

/** Every pair of actions whose effective bindings collide in overlapping contexts. */
export function findConflicts(
  actions: readonly AppAction[],
  bindings: ReadonlyMap<string, ParsedBinding | null>,
): BindingConflict[] {
  const conflicts: BindingConflict[] = [];
  actions.forEach((action, index) => {
    const binding = bindings.get(action.id);
    if (!binding) return;
    for (const other of actions.slice(index + 1)) {
      const otherBinding = bindings.get(other.id);
      if (!otherBinding) continue;
      if (contextsOverlap(action, other) && bindingsCollide(binding, otherBinding)) {
        conflicts.push({ actionIds: [action.id, other.id], binding: binding.canonical });
      }
    }
  });
  return conflicts;
}

export type RemapResult =
  | {
      readonly ok: true;
      readonly binding: ParsedBinding | null;
      readonly preferences: KeyboardPreferences;
    }
  | { readonly ok: false; readonly reason: "unknown_action"; readonly message: string }
  | { readonly ok: false; readonly reason: "invalid"; readonly message: string }
  | { readonly ok: false; readonly reason: "reserved"; readonly message: string }
  | {
      readonly ok: false;
      readonly reason: "conflict";
      readonly message: string;
      readonly conflictsWith: readonly string[];
    };

/**
 * Validates a remap before it is saved: rejects unknown actions, malformed bindings, reserved
 * browser/OS keys and conflicts in overlapping contexts. `binding: null` unbinds the action.
 */
export function validateRemap(
  actionId: string,
  binding: string | null,
  actions: readonly AppAction[],
  preferences: KeyboardPreferences,
  platform: Platform,
): RemapResult {
  const action = actions.find((candidate) => candidate.id === actionId);
  if (!action)
    return { ok: false, reason: "unknown_action", message: "That action does not exist" };
  if (binding === null) {
    return {
      ok: true,
      binding: null,
      preferences: { ...preferences, overrides: { ...preferences.overrides, [actionId]: null } },
    };
  }
  let parsed: ParsedBinding;
  try {
    parsed = parseBinding(binding);
  } catch (error) {
    if (error instanceof BindingSyntaxError) {
      return { ok: false, reason: "invalid", message: error.message };
    }
    throw error;
  }
  const ownsDefault =
    action.defaultBinding !== undefined &&
    tryParseBinding(action.defaultBinding)?.canonical === parsed.canonical;
  if (!ownsDefault && isReservedBinding(parsed.canonical, platform)) {
    return {
      ok: false,
      reason: "reserved",
      message: "That shortcut belongs to your browser or operating system",
    };
  }
  const next: KeyboardPreferences = {
    ...preferences,
    overrides: { ...preferences.overrides, [actionId]: parsed.canonical },
  };
  const bindings = effectiveBindings(actions, next);
  const conflictsWith = findConflicts(actions, bindings)
    .filter((conflict) => conflict.actionIds.includes(actionId))
    .map((conflict) =>
      conflict.actionIds[0] === actionId ? conflict.actionIds[1] : conflict.actionIds[0],
    );
  if (conflictsWith.length > 0) {
    return {
      ok: false,
      reason: "conflict",
      message: "Another action already uses that shortcut here",
      conflictsWith,
    };
  }
  return { ok: true, binding: parsed, preferences: next };
}

/** Restore defaults: clears every remap and re-enables single-key shortcuts. */
export function restoreDefaultBindings(): KeyboardPreferences {
  return DEFAULT_KEYBOARD_PREFERENCES;
}

/**
 * Reads stored keyboard preferences defensively: malformed, reserved or conflicting overrides are
 * dropped so a bad stored value can never hijack a browser control or shadow another action.
 */
export function parseKeyboardPreferences(
  value: unknown,
  actions: readonly AppAction[],
  platform: Platform,
): KeyboardPreferences {
  if (typeof value !== "object" || value === null) return DEFAULT_KEYBOARD_PREFERENCES;
  const record = value as { overrides?: unknown; singleKeyShortcuts?: unknown };
  const singleKeyShortcuts =
    typeof record.singleKeyShortcuts === "boolean" ? record.singleKeyShortcuts : true;
  let preferences: KeyboardPreferences = { overrides: {}, singleKeyShortcuts };
  if (typeof record.overrides === "object" && record.overrides !== null) {
    for (const [actionId, binding] of Object.entries(record.overrides)) {
      if (binding !== null && typeof binding !== "string") continue;
      const result = validateRemap(actionId, binding, actions, preferences, platform);
      if (result.ok) preferences = result.preferences;
    }
  }
  return preferences;
}

/** Whether a binding is ignored because single-key shortcuts are disabled. */
export function isSuppressedBySingleKeyToggle(
  binding: ParsedBinding,
  preferences: KeyboardPreferences,
): boolean {
  return !preferences.singleKeyShortcuts && isSingleKeyBinding(binding);
}
