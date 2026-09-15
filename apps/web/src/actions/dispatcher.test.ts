import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardPreferences } from "./bindings.ts";
import { type DispatchResult, KeyboardDispatcher } from "./dispatcher.ts";
import type { ActionEnvironment, ActionServices, AppAction } from "./types.ts";

const services: ActionServices = {
  navigate: vi.fn(),
  assign: vi.fn(),
  announce: vi.fn(),
  route: null,
  shell: null,
};

interface Harness {
  dispatcher: KeyboardDispatcher;
  results: DispatchResult[];
  ran: string[];
  environments: ActionEnvironment[];
  press: (
    target: Element,
    init: KeyboardEventInit & { key: string },
  ) => { result: DispatchResult | undefined; event: KeyboardEvent };
  disabled: Array<{ id: string; reason: string | undefined }>;
  sequences: Array<readonly string[] | null>;
  setPreferences: (preferences: KeyboardPreferences) => void;
  errors: unknown[];
}

function track(id: string, harness: { ran: string[]; environments: ActionEnvironment[] }) {
  return (environment: ActionEnvironment) => {
    harness.ran.push(id);
    harness.environments.push(environment);
  };
}

let cleanup: (() => void) | null = null;

function setup(
  build: (record: { ran: string[]; environments: ActionEnvironment[] }) => AppAction[],
  platform: "mac" | "other" = "other",
): Harness {
  const record = { ran: [] as string[], environments: [] as ActionEnvironment[] };
  const actions = build(record);
  const results: DispatchResult[] = [];
  const disabled: Harness["disabled"] = [];
  const sequences: Harness["sequences"] = [];
  const errors: unknown[] = [];
  let preferences: KeyboardPreferences = { overrides: {}, singleKeyShortcuts: true };
  const dispatcher = new KeyboardDispatcher({
    getActions: () => actions,
    getPreferences: () => preferences,
    getServices: () => services,
    platform,
    document,
    sequenceTimeoutMs: 1000,
    onDisabled: (action, reason) => disabled.push({ id: action.id, reason }),
    onSequenceChange: (steps) => sequences.push(steps),
    onError: (_action, error) => errors.push(error),
  });
  const listener = (event: KeyboardEvent) => {
    results.push(dispatcher.handleKeyDown(event));
  };
  document.addEventListener("keydown", listener);
  cleanup = () => {
    document.removeEventListener("keydown", listener);
    dispatcher.dispose();
  };
  return {
    dispatcher,
    results,
    ...record,
    disabled,
    sequences,
    errors,
    setPreferences: (next) => {
      preferences = next;
    },
    press: (target, init) => {
      const before = results.length;
      const code = init.code ?? (/^[a-z]$/i.test(init.key) ? `Key${init.key.toUpperCase()}` : "");
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code,
        ...init,
      });
      target.dispatchEvent(event);
      return { result: results[before], event };
    },
  };
}

function action(partial: Partial<AppAction> & Pick<AppAction, "id" | "context">): AppAction {
  return {
    label: partial.id,
    availability: () => ({ enabled: true }),
    run: () => undefined,
    ...partial,
  };
}

beforeEach(() => {
  document.body.innerHTML = `
    <div data-pane="inbox"><div id="row" role="treeitem" tabindex="0">Row</div><button id="inbox-button">B</button></div>
    <div data-pane="chat" data-action-context="composer"><textarea id="composer"></textarea></div>
    <div data-pane="page"><div data-action-context="editor"><div id="editor" contenteditable="true"></div></div></div>
    <input id="search" type="search" />
    <input id="checkbox" type="checkbox" />
    <div id="plain" tabindex="0"></div>
    <div id="rich" role="textbox" tabindex="0"></div>
  `;
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
});

const byId = (id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(id);
  return element;
};

describe("precedence", () => {
  it("runs modal or menu actions before editor, pane and app actions", () => {
    const h = setup((r) => [
      action({ id: "app", context: "app", defaultBinding: "mod+enter", run: track("app", r) }),
      action({
        id: "composer",
        context: "composer",
        defaultBinding: "mod+enter",
        run: track("composer", r),
      }),
      action({
        id: "modal",
        context: "modal",
        defaultBinding: "mod+enter",
        run: track("modal", r),
      }),
    ]);
    h.press(byId("composer"), { key: "Enter", ctrlKey: true });
    expect(h.ran).toEqual(["composer"]);
    h.press(byId("plain"), { key: "Enter", ctrlKey: true });
    expect(h.ran).toEqual(["composer", "app"]);
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="dialog" aria-modal="true"><button id="in-modal">OK</button></div>',
    );
    h.press(byId("in-modal"), { key: "Enter", ctrlKey: true });
    expect(h.ran).toEqual(["composer", "app", "modal"]);
  });

  it("blocks pane and app actions while a modal is open, even if focus escaped it", () => {
    const h = setup((r) => [
      action({ id: "palette", context: "app", defaultBinding: "mod+k", run: track("palette", r) }),
    ]);
    document.body.insertAdjacentHTML("beforeend", '<div data-action-layer="modal"></div>');
    const { result, event } = h.press(byId("plain"), { key: "k", ctrlKey: true });
    expect(result).toEqual({ kind: "ignored" });
    expect(event.defaultPrevented).toBe(false);
    expect(h.ran).toEqual([]);
  });

  it("gives an open menu its own layer", () => {
    const h = setup((r) => [
      action({ id: "menu-close", context: "menu", defaultBinding: "mod+.", run: track("menu", r) }),
      action({ id: "app", context: "app", defaultBinding: "mod+.", run: track("app", r) }),
    ]);
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="menu"><div id="item" role="menuitem" tabindex="-1">A</div></div>',
    );
    h.press(byId("item"), { key: ".", ctrlKey: true });
    expect(h.ran).toEqual(["menu"]);
  });

  it("scopes pane actions to their pane and prefers pane-specific actions", () => {
    const h = setup((r) => [
      action({ id: "any-pane", context: "pane", defaultBinding: "x", run: track("any", r) }),
      action({
        id: "inbox",
        context: "pane",
        pane: "inbox",
        defaultBinding: "x",
        run: track("inbox", r),
      }),
      action({ id: "app-y", context: "app", defaultBinding: "y", run: track("app-y", r) }),
    ]);
    h.press(byId("row"), { key: "x" });
    expect(h.ran).toEqual(["inbox"]);
    expect(h.environments[0]?.pane).toBe("inbox");
    expect(h.environments[0]?.source).toBe("keyboard");
    h.press(byId("plain"), { key: "x" });
    expect(h.ran).toEqual(["inbox"]);
    h.press(byId("row"), { key: "y" });
    expect(h.ran).toEqual(["inbox", "app-y"]);
  });

  it("falls through to a lower-precedence action when the winner is disabled", () => {
    const h = setup((r) => [
      action({
        id: "editor-find",
        context: "editor",
        defaultBinding: "mod+f",
        availability: () => ({ enabled: false, reason: "Find is not available here" }),
        run: track("editor-find", r),
      }),
      action({
        id: "app-find",
        context: "app",
        defaultBinding: "mod+f",
        run: track("app-find", r),
      }),
    ]);
    h.press(byId("editor"), { key: "f", ctrlKey: true });
    expect(h.ran).toEqual(["app-find"]);
  });
});

describe("disabled actions", () => {
  it("never run, report their reason and leave the browser default alone", () => {
    const run = vi.fn();
    const h = setup(() => [
      action({
        id: "find",
        context: "app",
        defaultBinding: "mod+f",
        availability: () => ({ enabled: false, reason: "Open a task first" }),
        run,
      }),
    ]);
    const { result, event } = h.press(byId("plain"), { key: "f", ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "disabled", actionId: "find", reason: "Open a task first" });
    expect(h.disabled).toEqual([{ id: "find", reason: "Open a task first" }]);
    expect(event.defaultPrevented).toBe(false);
  });

  it("apply to buttons, menus and the palette through invoke", async () => {
    const run = vi.fn();
    const h = setup(() => [
      action({
        id: "locked",
        context: "app",
        availability: () => ({ enabled: false, reason: "Locked" }),
        run,
      }),
      action({ id: "open", context: "app", run }),
    ]);
    await expect(h.dispatcher.invoke("locked", "menu")).resolves.toEqual({
      kind: "disabled",
      actionId: "locked",
      reason: "Locked",
    });
    await expect(h.dispatcher.invoke("open", "palette", "chat")).resolves.toEqual({
      kind: "ran",
      actionId: "open",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ source: "palette", pane: "chat" });
    await expect(h.dispatcher.invoke("missing", "pointer")).resolves.toEqual({ kind: "unknown" });
  });
});

describe("typing and IME guard", () => {
  const typingTargets = ["search", "composer", "editor", "rich"];

  it.each(typingTargets)("ignores unmodified keys and sequences in %s", (id) => {
    const h = setup((r) => [
      action({ id: "new", context: "app", defaultBinding: "n", run: track("new", r) }),
      action({ id: "help", context: "app", defaultBinding: "?", run: track("help", r) }),
      action({ id: "chat", context: "app", defaultBinding: "g c", run: track("chat", r) }),
      action({
        id: "subtask",
        context: "app",
        defaultBinding: "shift+n",
        run: track("subtask", r),
      }),
    ]);
    const target = byId(id);
    for (const init of [
      { key: "n" },
      { key: "?", shiftKey: true },
      { key: "N", shiftKey: true },
      { key: "g" },
      { key: "c" },
    ]) {
      const { event } = h.press(target, init);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(h.ran).toEqual([]);
    expect(h.dispatcher.pendingSequence).toBeNull();
  });

  it("still runs modified shortcuts while typing", () => {
    const h = setup((r) => [
      action({ id: "palette", context: "app", defaultBinding: "mod+k", run: track("palette", r) }),
    ]);
    h.press(byId("editor"), { key: "k", ctrlKey: true });
    expect(h.ran).toEqual(["palette"]);
  });

  it("never dispatches during IME composition, even for modified shortcuts", () => {
    const h = setup((r) => [
      action({
        id: "send",
        context: "composer",
        defaultBinding: "mod+enter",
        run: track("send", r),
      }),
    ]);
    const composing = h.press(byId("composer"), { key: "Enter", ctrlKey: true, isComposing: true });
    expect(composing.result).toEqual({ kind: "ignored" });
    const process = h.press(byId("composer"), { key: "Process", ctrlKey: true, keyCode: 229 });
    expect(process.result).toEqual({ kind: "ignored" });
    expect(h.ran).toEqual([]);
  });

  it("leaves Enter and Space to focused buttons and checkboxes", () => {
    const h = setup((r) => [
      action({
        id: "open",
        context: "pane",
        pane: "inbox",
        defaultBinding: "enter",
        run: track("open", r),
      }),
      action({
        id: "complete",
        context: "app",
        defaultBinding: "space",
        run: track("complete", r),
      }),
    ]);
    h.press(byId("inbox-button"), { key: "Enter" });
    h.press(byId("checkbox"), { key: " " });
    expect(h.ran).toEqual([]);
    h.press(byId("row"), { key: "Enter" });
    expect(h.ran).toEqual(["open"]);
  });

  it("skips events another handler already handled", () => {
    const h = setup((r) => [
      action({ id: "x", context: "app", defaultBinding: "x", run: track("x", r) }),
    ]);
    const target = byId("plain");
    target.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    h.press(target, { key: "x" });
    expect(h.ran).toEqual([]);
  });
});

describe("sequences", () => {
  function sequenceSetup() {
    return setup((r) => [
      action({ id: "chat", context: "app", defaultBinding: "g c", run: track("chat", r) }),
      action({ id: "inbox", context: "app", defaultBinding: "g i", run: track("inbox", r) }),
      action({ id: "complete", context: "app", defaultBinding: "c", run: track("complete", r) }),
      action({ id: "deep", context: "app", defaultBinding: "g o d", run: track("deep", r) }),
    ]);
  }

  it("completes g then c and reports progress", () => {
    const h = sequenceSetup();
    const first = h.press(byId("plain"), { key: "g" });
    expect(first.result).toEqual({ kind: "sequence-pending", steps: ["g"] });
    expect(first.event.defaultPrevented).toBe(true);
    expect(h.dispatcher.pendingSequence).toEqual(["g"]);
    h.press(byId("plain"), { key: "c" });
    expect(h.ran).toEqual(["chat"]);
    expect(h.sequences).toEqual([["g"], null]);
  });

  it("supports longer sequences", () => {
    const h = sequenceSetup();
    h.press(byId("plain"), { key: "g" });
    expect(h.press(byId("plain"), { key: "o" }).result).toEqual({
      kind: "sequence-pending",
      steps: ["g", "o"],
    });
    h.press(byId("plain"), { key: "d" });
    expect(h.ran).toEqual(["deep"]);
  });

  it("resets after the timeout so a later key runs on its own", () => {
    vi.useFakeTimers();
    const h = sequenceSetup();
    h.press(byId("plain"), { key: "g" });
    vi.advanceTimersByTime(1001);
    expect(h.dispatcher.pendingSequence).toBeNull();
    h.press(byId("plain"), { key: "c" });
    expect(h.ran).toEqual(["complete"]);
  });

  it("resets on Escape and consumes it", () => {
    const h = sequenceSetup();
    h.press(byId("plain"), { key: "g" });
    const escapePress = h.press(byId("plain"), { key: "Escape" });
    expect(escapePress.result).toEqual({ kind: "sequence-reset" });
    expect(escapePress.event.defaultPrevented).toBe(true);
    h.press(byId("plain"), { key: "c" });
    expect(h.ran).toEqual(["complete"]);
  });

  it("drops the sequence on an unrelated key and treats that key as fresh", () => {
    const h = sequenceSetup();
    h.press(byId("plain"), { key: "g" });
    h.press(byId("plain"), { key: "z" });
    expect(h.dispatcher.pendingSequence).toBeNull();
    h.press(byId("plain"), { key: "c" });
    expect(h.ran).toEqual(["complete"]);
  });

  it("drops the sequence when focus moves into a text field", () => {
    const h = sequenceSetup();
    h.press(byId("plain"), { key: "g" });
    h.press(byId("search"), { key: "c" });
    expect(h.ran).toEqual([]);
    expect(h.dispatcher.pendingSequence).toBeNull();
  });

  it("ignores a held first key", () => {
    const h = sequenceSetup();
    h.press(byId("plain"), { key: "g" });
    h.press(byId("plain"), { key: "g", repeat: true });
    expect(h.dispatcher.pendingSequence).toEqual(["g"]);
  });
});

describe("held-key repeat", () => {
  it("suppresses repeat for create, complete and send, and allows it for navigation", () => {
    const h = setup((r) => [
      action({
        id: "complete",
        context: "pane",
        pane: "inbox",
        defaultBinding: "x",
        run: track("complete", r),
      }),
      action({
        id: "next",
        context: "pane",
        pane: "inbox",
        defaultBinding: "j",
        allowRepeat: true,
        run: track("next", r),
      }),
    ]);
    h.press(byId("row"), { key: "x" });
    const held = h.press(byId("row"), { key: "x", repeat: true });
    expect(held.result).toEqual({ kind: "repeat-suppressed", actionId: "complete" });
    expect(held.event.defaultPrevented).toBe(true);
    h.press(byId("row"), { key: "j" });
    h.press(byId("row"), { key: "j", repeat: true });
    h.press(byId("row"), { key: "j", repeat: true });
    expect(h.ran).toEqual(["complete", "next", "next", "next"]);
  });
});

describe("preferences", () => {
  it("applies remaps and unbinding", () => {
    const h = setup((r) => [
      action({ id: "complete", context: "app", defaultBinding: "x", run: track("complete", r) }),
      action({ id: "palette", context: "app", defaultBinding: "mod+k", run: track("palette", r) }),
    ]);
    h.setPreferences({
      overrides: { complete: "shift+x", palette: null },
      singleKeyShortcuts: true,
    });
    h.press(byId("plain"), { key: "x" });
    h.press(byId("plain"), { key: "k", ctrlKey: true });
    expect(h.ran).toEqual([]);
    h.press(byId("plain"), { key: "X", shiftKey: true });
    expect(h.ran).toEqual(["complete"]);
  });

  it("disables single-key shortcuts and sequences without touching chords", () => {
    const h = setup((r) => [
      action({ id: "complete", context: "app", defaultBinding: "x", run: track("complete", r) }),
      action({ id: "chat", context: "app", defaultBinding: "g c", run: track("chat", r) }),
      action({ id: "palette", context: "app", defaultBinding: "mod+k", run: track("palette", r) }),
    ]);
    h.setPreferences({ overrides: {}, singleKeyShortcuts: false });
    h.press(byId("plain"), { key: "x" });
    h.press(byId("plain"), { key: "g" });
    h.press(byId("plain"), { key: "c" });
    h.press(byId("plain"), { key: "k", ctrlKey: true });
    expect(h.ran).toEqual(["palette"]);
  });

  it("maps Mod per platform", () => {
    const h = setup(
      (r) => [
        action({
          id: "palette",
          context: "app",
          defaultBinding: "mod+k",
          run: track("palette", r),
        }),
      ],
      "mac",
    );
    h.press(byId("plain"), { key: "k", ctrlKey: true });
    expect(h.ran).toEqual([]);
    h.press(byId("plain"), { key: "k", metaKey: true });
    expect(h.ran).toEqual(["palette"]);
  });
});

describe("errors", () => {
  it("contains synchronous throws and async rejections", async () => {
    const h = setup(() => [
      action({
        id: "boom",
        context: "app",
        defaultBinding: "b",
        run: () => {
          throw new Error("sync");
        },
      }),
      action({
        id: "later",
        context: "app",
        defaultBinding: "l",
        run: () => Promise.reject(new Error("async")),
      }),
    ]);
    expect(h.press(byId("plain"), { key: "b" }).result).toEqual({ kind: "ran", actionId: "boom" });
    h.press(byId("plain"), { key: "l" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.errors.map((error) => (error as Error).message)).toEqual(["sync", "async"]);
  });
});
