import { describe, expect, it } from "vitest";
import {
  bindingsCollide,
  contextsOverlap,
  DEFAULT_KEYBOARD_PREFERENCES,
  effectiveBindings,
  findConflicts,
  isReservedBinding,
  isSuppressedBySingleKeyToggle,
  parseKeyboardPreferences,
  restoreDefaultBindings,
  validateRemap,
} from "./bindings.ts";
import { parseBinding } from "./keys.ts";
import type { AppAction } from "./types.ts";

function action(partial: Partial<AppAction> & Pick<AppAction, "id" | "context">): AppAction {
  return {
    label: partial.id,
    availability: () => ({ enabled: true }),
    run: () => undefined,
    ...partial,
  };
}

const actions: AppAction[] = [
  action({ id: "palette.open", context: "app", defaultBinding: "mod+k" }),
  action({ id: "shell.focus_chat", context: "app", defaultBinding: "g c" }),
  action({ id: "shell.focus_inbox", context: "app", defaultBinding: "g i" }),
  action({ id: "task.complete", context: "pane", pane: "inbox", defaultBinding: "x" }),
  action({ id: "chat.send", context: "composer", defaultBinding: "mod+enter" }),
  action({ id: "doc.save", context: "editor", defaultBinding: "mod+s" }),
  action({ id: "task.next", context: "pane", pane: "inbox", defaultBinding: "j" }),
  action({ id: "dialog.confirm", context: "modal", defaultBinding: "mod+enter" }),
  action({ id: "run.stop", context: "app" }),
];

describe("effective bindings", () => {
  it("uses defaults, applies overrides and honors unbinding", () => {
    const bindings = effectiveBindings(actions, {
      overrides: { "task.complete": "shift+x", "palette.open": null },
      singleKeyShortcuts: true,
    });
    expect(bindings.get("task.complete")?.canonical).toBe("shift+x");
    expect(bindings.get("palette.open")).toBeNull();
    expect(bindings.get("shell.focus_chat")?.canonical).toBe("g c");
    expect(bindings.get("run.stop")).toBeNull();
  });

  it("has no conflicts among the defaults above", () => {
    expect(
      findConflicts(actions, effectiveBindings(actions, DEFAULT_KEYBOARD_PREFERENCES)),
    ).toEqual([]);
  });
});

describe("context overlap and collisions", () => {
  it("treats different panes, editor versus composer and modal versus app as exclusive", () => {
    const inbox = action({ id: "a", context: "pane", pane: "inbox" });
    const chatPane = action({ id: "b", context: "pane", pane: "chat" });
    const anyPane = action({ id: "c", context: "pane" });
    expect(contextsOverlap(inbox, chatPane)).toBe(false);
    expect(contextsOverlap(inbox, anyPane)).toBe(true);
    expect(
      contextsOverlap(
        action({ id: "e", context: "editor" }),
        action({ id: "f", context: "composer" }),
      ),
    ).toBe(false);
    expect(
      contextsOverlap(action({ id: "g", context: "modal" }), action({ id: "h", context: "app" })),
    ).toBe(false);
    expect(
      contextsOverlap(action({ id: "i", context: "app" }), action({ id: "j", context: "editor" })),
    ).toBe(true);
    expect(
      contextsOverlap(action({ id: "k", context: "app" }), action({ id: "l", context: "app" })),
    ).toBe(true);
  });

  it("detects equal bindings and sequence prefixes", () => {
    expect(bindingsCollide(parseBinding("g c"), parseBinding("g c"))).toBe(true);
    expect(bindingsCollide(parseBinding("g"), parseBinding("g c"))).toBe(true);
    expect(bindingsCollide(parseBinding("g c"), parseBinding("g i"))).toBe(false);
    expect(bindingsCollide(parseBinding("mod+k"), parseBinding("k"))).toBe(false);
  });
});

describe("validateRemap", () => {
  const prefs = DEFAULT_KEYBOARD_PREFERENCES;

  it("accepts a supported assignment and returns the next preferences", () => {
    const result = validateRemap("run.stop", "mod+shift+u", actions, prefs, "mac");
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.binding?.canonical).toBe("mod+shift+u");
      expect(result.preferences.overrides).toEqual({ "run.stop": "mod+shift+u" });
    }
  });

  it("rejects malformed bindings with a message", () => {
    expect(validateRemap("run.stop", "mod+", actions, prefs, "other")).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects unknown actions", () => {
    expect(validateRemap("nope", "x", actions, prefs, "other")).toMatchObject({
      ok: false,
      reason: "unknown_action",
    });
  });

  it.each([
    ["mod+t", "other"],
    ["mod+w", "mac"],
    ["mod+l", "other"],
    ["mod+r", "mac"],
    ["tab", "other"],
    ["escape", "other"],
    ["mod+c", "other"],
    ["mod+z", "mac"],
    ["alt+arrowleft", "other"],
    ["mod+[", "mac"],
    ["mod+q", "mac"],
    ["alt+f4", "other"],
    ["mod+1", "other"],
    ["f5", "mac"],
  ] as const)("rejects the reserved browser or OS shortcut %s on %s", (binding, platform) => {
    expect(validateRemap("run.stop", binding, actions, prefs, platform)).toMatchObject({
      ok: false,
      reason: "reserved",
    });
    expect(isReservedBinding(parseBinding(binding).canonical, platform)).toBe(true);
  });

  it("lets an action keep a default that browsers also use (Mod+S save, Mod+K palette)", () => {
    expect(validateRemap("doc.save", "mod+s", actions, prefs, "other")).toMatchObject({ ok: true });
    expect(validateRemap("palette.open", "mod+k", actions, prefs, "other")).toMatchObject({
      ok: true,
    });
    expect(validateRemap("run.stop", "mod+k", actions, prefs, "other")).toMatchObject({
      ok: false,
      reason: "reserved",
    });
  });

  it("reports conflicts in overlapping contexts, including sequence prefixes", () => {
    expect(validateRemap("run.stop", "g c", actions, prefs, "other")).toMatchObject({
      ok: false,
      reason: "conflict",
      conflictsWith: ["shell.focus_chat"],
    });
    expect(validateRemap("run.stop", "g", actions, prefs, "other")).toMatchObject({
      ok: false,
      reason: "conflict",
      conflictsWith: ["shell.focus_chat", "shell.focus_inbox"],
    });
    // An app shortcut would be shadowed inside the inbox pane.
    expect(validateRemap("run.stop", "x", actions, prefs, "other")).toMatchObject({
      ok: false,
      reason: "conflict",
      conflictsWith: ["task.complete"],
    });
  });

  it("allows duplicate bindings in mutually exclusive contexts", () => {
    const exclusive = [
      ...actions,
      action({ id: "chat.next", context: "pane", pane: "chat", defaultBinding: "k" }),
    ];
    expect(validateRemap("chat.next", "j", exclusive, prefs, "other")).toMatchObject({ ok: true });
    // Modal Mod+Enter and composer Mod+Enter already coexist.
    expect(findConflicts(exclusive, effectiveBindings(exclusive, prefs))).toEqual([]);
  });

  it("unbinds with null and restores defaults", () => {
    const result = validateRemap("task.complete", null, actions, prefs, "other");
    expect(result).toMatchObject({ ok: true, binding: null });
    if (result.ok)
      expect(effectiveBindings(actions, result.preferences).get("task.complete")).toBeNull();
    expect(restoreDefaultBindings()).toEqual(DEFAULT_KEYBOARD_PREFERENCES);
  });

  it("frees a binding for reuse once its owner is remapped", () => {
    const moved = validateRemap("shell.focus_chat", "g h", actions, prefs, "other");
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(validateRemap("run.stop", "g c", actions, moved.preferences, "other")).toMatchObject({
      ok: true,
    });
  });
});

describe("stored keyboard preferences", () => {
  it("drops malformed, reserved and conflicting overrides", () => {
    const parsed = parseKeyboardPreferences(
      {
        singleKeyShortcuts: false,
        overrides: {
          "run.stop": "mod+t",
          "task.complete": "not a key",
          "palette.open": 42,
          "shell.focus_inbox": "g c",
          "chat.send": null,
          unknown: "mod+u",
        },
      },
      actions,
      "other",
    );
    expect(parsed).toEqual({ singleKeyShortcuts: false, overrides: { "chat.send": null } });
  });

  it("falls back to defaults for non-objects", () => {
    expect(parseKeyboardPreferences("nope", actions, "mac")).toEqual(DEFAULT_KEYBOARD_PREFERENCES);
    expect(parseKeyboardPreferences(null, actions, "mac")).toEqual(DEFAULT_KEYBOARD_PREFERENCES);
  });

  it("suppresses single-key bindings only when the toggle is off", () => {
    const off = { overrides: {}, singleKeyShortcuts: false };
    expect(isSuppressedBySingleKeyToggle(parseBinding("x"), off)).toBe(true);
    expect(isSuppressedBySingleKeyToggle(parseBinding("g c"), off)).toBe(true);
    expect(isSuppressedBySingleKeyToggle(parseBinding("mod+k"), off)).toBe(false);
    expect(isSuppressedBySingleKeyToggle(parseBinding("x"), DEFAULT_KEYBOARD_PREFERENCES)).toBe(
      false,
    );
  });
});
