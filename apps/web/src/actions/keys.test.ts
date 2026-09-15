import { describe, expect, it } from "vitest";
import {
  chordCanonical,
  chordFromEvent,
  detectPlatform,
  formatBinding,
  isSingleKeyBinding,
  type KeyEventLike,
  parseBinding,
  tryParseBinding,
} from "./keys.ts";

function key(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...partial };
}

describe("parseBinding", () => {
  it.each([
    ["mod+k", "mod+k"],
    ["Shift+Mod+K", "mod+shift+k"],
    ["cmd+enter", "mod+enter"],
    ["Mod+Return", "mod+enter"],
    ["shift+N", "shift+n"],
    ["?", "?"],
    ["/", "/"],
    ["]", "]"],
    ["g c", "g c"],
    ["G   I", "g i"],
    ["shift+f10", "shift+f10"],
    ["esc", "escape"],
    ["up", "arrowup"],
    ["mod+plus", "mod+plus"],
    ["alt+shift+arrowdown", "alt+shift+arrowdown"],
  ])("canonicalizes %j as %s", (input, canonical) => {
    expect(parseBinding(input).canonical).toBe(canonical);
  });

  it.each([
    "",
    "   ",
    "mod+",
    "hyper+k",
    "mod+mod+k",
    "mod+ctrl+k",
    "mod+meta+k",
    "shift+/",
    "shift+?",
    "g mod+c",
    "g enter",
    "a b c d",
    "mod+é",
    "ctrl+F13",
  ])("rejects %j", (input) => {
    expect(() => parseBinding(input)).toThrow();
    expect(tryParseBinding(input)).toBeNull();
  });

  it("classifies single-key shortcuts", () => {
    expect(isSingleKeyBinding(parseBinding("x"))).toBe(true);
    expect(isSingleKeyBinding(parseBinding("shift+n"))).toBe(true);
    expect(isSingleKeyBinding(parseBinding("?"))).toBe(true);
    expect(isSingleKeyBinding(parseBinding("g c"))).toBe(true);
    expect(isSingleKeyBinding(parseBinding("mod+k"))).toBe(false);
    expect(isSingleKeyBinding(parseBinding("enter"))).toBe(false);
    expect(isSingleKeyBinding(parseBinding("arrowdown"))).toBe(false);
  });
});

describe("chordFromEvent", () => {
  it("maps Mod to Command on macOS and Control elsewhere", () => {
    const mac = chordFromEvent(key({ key: "k", code: "KeyK", metaKey: true }), "mac");
    const win = chordFromEvent(key({ key: "k", code: "KeyK", ctrlKey: true }), "other");
    expect(mac && chordCanonical(mac)).toBe("mod+k");
    expect(win && chordCanonical(win)).toBe("mod+k");
    const macCtrl = chordFromEvent(key({ key: "k", code: "KeyK", ctrlKey: true }), "mac");
    expect(macCtrl && chordCanonical(macCtrl)).toBe("ctrl+k");
    const winMeta = chordFromEvent(key({ key: "k", code: "KeyK", metaKey: true }), "other");
    expect(winMeta && chordCanonical(winMeta)).toBe("meta+k");
  });

  it("keeps Shift for letters and drops it for punctuation the character already implies", () => {
    const upper = chordFromEvent(key({ key: "N", code: "KeyN", shiftKey: true }), "other");
    expect(upper && chordCanonical(upper)).toBe("shift+n");
    const question = chordFromEvent(key({ key: "?", code: "Slash", shiftKey: true }), "other");
    expect(question && chordCanonical(question)).toBe("?");
  });

  it("uses the physical key when Option changes the character or the layout is not Latin", () => {
    const option = chordFromEvent(key({ key: "©", code: "KeyG", altKey: true }), "mac");
    expect(option && chordCanonical(option)).toBe("alt+g");
    const cyrillic = chordFromEvent(key({ key: "п", code: "KeyG" }), "other");
    expect(cyrillic && chordCanonical(cyrillic)).toBe("g");
  });

  it("normalizes named keys and ignores modifier-only and composition keys", () => {
    expect(chordCanonical(chordFromEvent(key({ key: " ", code: "Space" }), "other") as never)).toBe(
      "space",
    );
    expect(chordCanonical(chordFromEvent(key({ key: "Esc" }), "other") as never)).toBe("escape");
    expect(chordFromEvent(key({ key: "Shift", shiftKey: true }), "other")).toBeNull();
    expect(chordFromEvent(key({ key: "Meta", metaKey: true }), "mac")).toBeNull();
    expect(chordFromEvent(key({ key: "Process" }), "other")).toBeNull();
    expect(chordFromEvent(key({ key: "Dead", code: "Quote" }), "other")).toBeNull();
    expect(chordFromEvent(key({ key: "" }), "other")).toBeNull();
  });
});

describe("platform detection and labels", () => {
  it("detects macOS and iOS", () => {
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" })).toBe(
      "mac",
    );
    expect(detectPlatform({ platform: "Win32" })).toBe("other");
    expect(detectPlatform({ platform: "Linux x86_64" })).toBe("other");
    expect(detectPlatform(undefined)).toBe("other");
  });

  it("formats chords with native key names", () => {
    expect(formatBinding("mod+k", "mac")).toMatchObject({ display: "⌘K", spoken: "Command K" });
    expect(formatBinding("mod+k", "other")).toMatchObject({
      display: "Ctrl+K",
      spoken: "Control K",
    });
    expect(formatBinding("mod+enter", "mac").display).toBe("⌘↩");
    expect(formatBinding("mod+enter", "other").display).toBe("Ctrl+Enter");
    expect(formatBinding("shift+n", "mac").display).toBe("⇧N");
    expect(formatBinding("shift+f10", "other").display).toBe("Shift+F10");
    expect(formatBinding("?", "other")).toMatchObject({ display: "?", spoken: "Question mark" });
  });

  it("distinguishes sequences from chords", () => {
    const label = formatBinding("g c", "mac");
    expect(label.steps).toHaveLength(2);
    expect(label.display).toBe("G then C");
    expect(label.spoken).toBe("G, then C");
  });

  it("never exposes raw event codes", () => {
    for (const binding of ["mod+k", "g c", "shift+f10", "alt+arrowleft", "/"]) {
      for (const platform of ["mac", "other"] as const) {
        expect(formatBinding(binding, platform).display).not.toMatch(/Key[A-Z]|Digit|Arrow/);
      }
    }
  });
});
